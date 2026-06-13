import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AuthProvider as OidcAuthProvider,
  AuthProviderProps as OidcAuthProviderProps,
  useAuth as useOidcAuth,
} from "react-oidc-context";
import { User, WebStorageStateStore } from "oidc-client-ts";
import { decodeJwt } from "jose";

import type { Credentials } from "./Credentials";
import { createOidcConfig, oidcUserToLedgerAndCredentials } from "./oidcConfig";

export type AuthContextValue = {
  /** Ledger-derived credentials. Null while signed-out or while deriving. */
  credentials: Credentials | null;
  /** OIDC sign-in completed (does not imply credentials are derived yet). */
  isAuthenticated: boolean;
  /** OIDC layer is loading (sign-in / silent-renew in flight). */
  isLoading: boolean;
  /** Credentials are being derived from the OIDC user. */
  isDerivingCredentials: boolean;
  /** OIDC error, if any. */
  error: Error | undefined;
  /**
   * Last error thrown while deriving ledger credentials from the OIDC user —
   * typically a "user not authorized on the ledger" / "user not found"
   * response from `GET /v2/users/{sub}` when the IdP-issued `sub` has no
   * matching Daml user. Set in the derive effect's `.catch`, cleared at the
   * start of each derivation attempt, on successful derivation, on
   * `setCredentials(...)`, and on `logout()`. Apps render this on the login
   * surface so the user sees a real error instead of being silently bounced
   * back to "sign in".
   */
  derivationError: Error | undefined;
  /** Raw OIDC user (access_token, id_token, profile). */
  user: User | null | undefined;
  /** Start the OIDC redirect login flow. */
  loginWithOidc: () => void;
  /** Inject credentials directly (for token-based / dev login paths). */
  setCredentials: (credentials: Credentials | null) => void;
  /** Clear credentials and end the SSO session at the IdP. */
  logout: () => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

const DEFAULT_STORAGE_KEY = "auth_credentials";

const readStoredCredentials = (storageKey: string): Credentials | null => {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(storageKey);
    return raw ? (JSON.parse(raw) as Credentials) : null;
  } catch {
    return null;
  }
};

const writeStoredCredentials = (
  storageKey: string,
  credentials: Credentials | null,
): void => {
  if (typeof window === "undefined") return;
  try {
    if (credentials === null) {
      window.sessionStorage.removeItem(storageKey);
    } else {
      window.sessionStorage.setItem(storageKey, JSON.stringify(credentials));
    }
  } catch {
    // storage can throw (private mode, quota); fall back to in-memory state
  }
};

export type AuthProviderProps = {
  oidcAuthority: string;
  oidcClientId: string;
  /** Base URL of the JSON Ledger API. Forwarded to `oidcUserToLedgerAndCredentials`. */
  httpBaseUrl: string;
  /** Optional audience query param (Auth0-style IdPs). */
  audience?: string;
  /** Override the sessionStorage key. Default: "auth_credentials". */
  storageKey?: string;
  /**
   * Called after OIDC strips the auth params from the URL on the redirect
   * callback. Useful for app-level routing decisions; credentials derivation
   * is automatic.
   */
  onSigninCallback?: () => void;
  children: React.ReactNode;
};

/**
 * Single source of truth for authentication across Canton-based C7 apps.
 *
 * Wraps `react-oidc-context`'s provider and adds:
 *   - automatic derivation of ledger credentials from the OIDC user,
 *   - mirroring of refreshed access tokens into credentials,
 *   - sessionStorage persistence so reloads don't kick the user out,
 *   - a logout that talks to Keycloak correctly (sends `id_token_hint`).
 *
 * Browser-only. Reads `window.sessionStorage`, `window.location`, and
 * `window.history` directly; rendering this in an SSR environment will
 * throw at first render.
 */
export const AuthProvider: React.FC<AuthProviderProps> = ({
  oidcAuthority,
  oidcClientId,
  httpBaseUrl,
  audience,
  storageKey = DEFAULT_STORAGE_KEY,
  onSigninCallback,
  children,
}) => {
  const oidcConfig: OidcAuthProviderProps = useMemo(
    () => {
      if (typeof window === "undefined") {
        throw new Error(
          "AuthProvider requires a browser environment (window/sessionStorage). " +
            "It cannot be rendered server-side.",
        );
      }
      return {
        ...createOidcConfig(oidcAuthority, oidcClientId, audience),
        userStore: new WebStorageStateStore({ store: window.sessionStorage }),
        post_logout_redirect_uri: window.location.origin,
        onSigninCallback: () => {
          // Strip auth params off the URL after the redirect callback.
          window.history.replaceState({}, document.title, window.location.pathname);
          onSigninCallback?.();
        },
      };
    },
    [oidcAuthority, oidcClientId, audience, onSigninCallback],
  );

  return (
    <OidcAuthProvider {...oidcConfig}>
      <CredentialsProvider httpBaseUrl={httpBaseUrl} storageKey={storageKey}>
        {children}
      </CredentialsProvider>
    </OidcAuthProvider>
  );
};

const CredentialsProvider: React.FC<{
  httpBaseUrl: string;
  storageKey: string;
  children: React.ReactNode;
}> = ({ httpBaseUrl, storageKey, children }) => {
  const oidc = useOidcAuth();
  const [credentials, setCredentialsState] = useState<Credentials | null>(() =>
    readStoredCredentials(storageKey),
  );
  const [isDerivingCredentials, setIsDerivingCredentials] = useState(false);
  const [derivationError, setDerivationError] = useState<Error | undefined>(
    undefined,
  );

  // Always-latest ref to credentials. Read inside async timer callbacks
  // that need to compare against current state without re-subscribing.
  const credentialsRef = useRef<Credentials | null>(credentials);
  useEffect(() => {
    credentialsRef.current = credentials;
  });

  // Monotonic attempt counter: every fresh derivation bumps it; the in-flight
  // promise stamps a local copy, and the .finally only clears
  // isDerivingCredentials if its stamp is still the latest. Without this, a
  // mid-flight cancellation (e.g. manual setCredentials while the OIDC derive
  // is still running) would leave isDerivingCredentials stuck on `true` —
  // the cancelled-guard short-circuit skipped the finally before this fix.
  const derivationAttemptRef = useRef(0);

  // Single writer: updates credentials state + sessionStorage AND the
  // derivationError partner in one shot, so both stay in sync. The catch in
  // the derive effect calls this with (null, normalizedError); external
  // callers (logout, manual injection, the token-mirror effect) call it
  // with (next, undefined) via the `setCredentials` wrapper to mean "fresh
  // write — any prior derivation error is moot now".
  const writeAuthState = useCallback(
    (next: Credentials | null, error: Error | undefined): void => {
      const normalized: Credentials | null = next
        ? { ...next, source: next.source ?? "manual" }
        : null;
      setCredentialsState(normalized);
      writeStoredCredentials(storageKey, normalized);
      setDerivationError(error);
    },
    [storageKey],
  );

  const setCredentials = useCallback(
    (next: Credentials | null): void => {
      writeAuthState(next, undefined);
    },
    [writeAuthState],
  );

  // Derive credentials whenever OIDC has a user but we don't have credentials
  // yet. Runs on the redirect callback AND on remount/reload when storage is
  // empty. Skipped when oidc.error is set — otherwise the invalidation
  // effect below could clear credentials and we'd immediately re-derive
  // them from the same broken session, looping. On failure, the thrown
  // Error lands on `derivationError` so apps can render it; before v0.0.22
  // it was logged to console only and the user saw a silent bounce back to
  // the login screen.
  useEffect(() => {
    if (!oidc.isAuthenticated || !oidc.user || credentials || oidc.error) return;
    let cancelled = false;
    const myAttempt = ++derivationAttemptRef.current;
    setIsDerivingCredentials(true);
    setDerivationError(undefined);
    oidcUserToLedgerAndCredentials(oidc.user, httpBaseUrl)
      .then(({ credentials: derived }) => {
        if (!cancelled) setCredentials(derived);
      })
      .catch((err: unknown) => {
        const normalized =
          err instanceof Error ? err : new Error(String(err));
        console.error("Failed to derive credentials from OIDC user", normalized);
        if (!cancelled) writeAuthState(null, normalized);
      })
      .finally(() => {
        // Only the latest in-flight attempt clears the flag. A cancelled
        // attempt whose .finally races a fresh attempt's set-true must not
        // flip it back to false, and a cancelled attempt whose promise
        // outlives the cancellation still has to clear the flag (otherwise
        // a mid-flight manual setCredentials leaves it stuck `true`).
        if (derivationAttemptRef.current === myAttempt) {
          setIsDerivingCredentials(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [
    oidc.isAuthenticated,
    oidc.user,
    oidc.error,
    credentials,
    setCredentials,
    writeAuthState,
    httpBaseUrl,
  ]);

  // Mirror refreshed access tokens into credentials so downstream consumers
  // (DamlLedger) see the new token in both state and storage.
  useEffect(() => {
    const newToken = oidc.user?.access_token;
    if (credentials && newToken && credentials.token !== newToken) {
      setCredentials({ ...credentials, token: newToken });
    }
  }, [oidc.user?.access_token, credentials, setCredentials]);

  // Drop stale OIDC-derived credentials once the OIDC layer has settled
  // and reports either an error (silent renew failed) or no authenticated
  // session. Without this, sessionStorage would keep the app "signed in"
  // with a token the IdP no longer recognizes. Manually-injected
  // credentials are intentionally left alone — they aren't tied to an
  // OIDC session.
  useEffect(() => {
    if (!credentials || credentials.source !== "oidc") return;
    if (oidc.isLoading) return;
    if (!oidc.isAuthenticated || oidc.error) {
      setCredentials(null);
    }
  }, [
    oidc.isLoading,
    oidc.isAuthenticated,
    oidc.error,
    credentials,
    setCredentials,
  ]);

  // JWT exp watchdog: if the cached access token is already expired, drop
  // it immediately; otherwise schedule a one-shot cleanup at exp so a
  // tab that misses silent-renew (e.g. wake-from-sleep, network blip)
  // doesn't keep using a dead token. Tokens without a parseable `exp`
  // are left as-is — opaque tokens are assumed to be managed elsewhere.
  useEffect(() => {
    if (!credentials) return;
    let exp: number | undefined;
    try {
      exp = decodeJwt(credentials.token).exp;
    } catch {
      setCredentials(null);
      return;
    }
    if (typeof exp !== "number") return;
    const msUntilExpiry = exp * 1000 - Date.now();
    if (msUntilExpiry <= 0) {
      setCredentials(null);
      return;
    }
    // Compare-and-swap on fire: only invalidate if the token we scheduled
    // against is still the one in play. In normal React flow the effect
    // cleanup clears `timer` before it can fire when credentials rotate,
    // but the cleanup itself runs *after* React commits the new state —
    // if the timer's macrotask was already queued by the runtime before
    // commit (long synchronous work, GC pause), it'd otherwise nuke a
    // freshly-rotated token. CAS makes that a no-op.
    const scheduledToken = credentials.token;
    const timer = setTimeout(() => {
      if (credentialsRef.current?.token === scheduledToken) {
        setCredentials(null);
      }
    }, msUntilExpiry);
    return () => clearTimeout(timer);
  }, [credentials, setCredentials]);

  const logout = useCallback(() => {
    setCredentials(null); // also clears sessionStorage + derivationError
    if (oidc.isAuthenticated) {
      // Do NOT call oidc.removeUser() first: signoutRedirect() reads the
      // User's id_token to send `id_token_hint` on the end-session request,
      // and Keycloak rejects post_logout_redirect_uri without it.
      // signoutRedirect() removes the user itself in the post-logout callback.
      void oidc.signoutRedirect();
    }
  }, [oidc, setCredentials]);

  const value: AuthContextValue = {
    credentials,
    isAuthenticated: oidc.isAuthenticated,
    isLoading: oidc.isLoading,
    isDerivingCredentials,
    error: oidc.error,
    derivationError,
    user: oidc.user,
    loginWithOidc: () => {
      void oidc.signinRedirect();
    },
    setCredentials,
    logout,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export const useAuth = (): AuthContextValue => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
};
