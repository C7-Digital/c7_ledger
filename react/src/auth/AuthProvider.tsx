import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  AuthProvider as OidcAuthProvider,
  AuthProviderProps as OidcAuthProviderProps,
  useAuth as useOidcAuth,
} from "react-oidc-context";
import { User, WebStorageStateStore } from "oidc-client-ts";

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
    () => ({
      ...createOidcConfig(oidcAuthority, oidcClientId, audience),
      userStore: new WebStorageStateStore({ store: window.sessionStorage }),
      post_logout_redirect_uri: window.location.origin,
      onSigninCallback: () => {
        // Strip auth params off the URL after the redirect callback.
        window.history.replaceState({}, document.title, window.location.pathname);
        onSigninCallback?.();
      },
    }),
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

  // Single writer: updates React state and mirrors through to sessionStorage.
  const setCredentials = useCallback(
    (next: Credentials | null): void => {
      setCredentialsState(next);
      writeStoredCredentials(storageKey, next);
    },
    [storageKey],
  );

  // Derive credentials whenever OIDC has a user but we don't have credentials
  // yet. Runs on the redirect callback AND on remount/reload when storage is
  // empty.
  useEffect(() => {
    if (!oidc.isAuthenticated || !oidc.user || credentials) return;
    let cancelled = false;
    setIsDerivingCredentials(true);
    oidcUserToLedgerAndCredentials(oidc.user, httpBaseUrl)
      .then(({ credentials: derived }) => {
        if (!cancelled) setCredentials(derived);
      })
      .catch((err) => {
        console.error("Failed to derive credentials from OIDC user", err);
        if (!cancelled) setCredentials(null);
      })
      .finally(() => {
        if (!cancelled) setIsDerivingCredentials(false);
      });
    return () => {
      cancelled = true;
    };
  }, [oidc.isAuthenticated, oidc.user, credentials, setCredentials, httpBaseUrl]);

  // Mirror refreshed access tokens into credentials so downstream consumers
  // (DamlLedger) see the new token in both state and storage.
  useEffect(() => {
    const newToken = oidc.user?.access_token;
    if (credentials && newToken && credentials.token !== newToken) {
      setCredentials({ ...credentials, token: newToken });
    }
  }, [oidc.user?.access_token, credentials, setCredentials]);

  const logout = useCallback(() => {
    setCredentials(null); // also clears sessionStorage
    if (oidc.isAuthenticated) {
      // Do NOT call oidc.removeUser() first: signoutRedirect() reads the
      // User's id_token to send `id_token_hint` on the end-session request,
      // and Keycloak rejects post_logout_redirect_uri without it.
      // signoutRedirect() removes the user itself in the post-logout callback.
      oidc.signoutRedirect();
    }
  }, [oidc, setCredentials]);

  const value: AuthContextValue = {
    credentials,
    isAuthenticated: oidc.isAuthenticated,
    isLoading: oidc.isLoading,
    isDerivingCredentials,
    error: oidc.error,
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
