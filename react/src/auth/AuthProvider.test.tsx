import React from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { AuthProvider, useAuth } from "./AuthProvider";
import type { Credentials } from "./Credentials";

// ---------------------------------------------------------------------------
// Mocks: react-oidc-context (drive isAuthenticated/user/error from the test)
// and @c7-digital/ledger/lite's Ledger (so credential derivation is a no-IO
// promise).
// ---------------------------------------------------------------------------

const oidcHarness = vi.hoisted(() => {
  type State = {
    isAuthenticated: boolean;
    isLoading: boolean;
    user: { access_token: string; id_token?: string; profile?: object } | null;
    error?: Error;
  };
  let current: State = { isAuthenticated: false, isLoading: true, user: null };
  const listeners = new Set<() => void>();
  return {
    getState: (): State => current,
    setState: (patch: Partial<State>): void => {
      current = { ...current, ...patch };
      listeners.forEach((l) => l());
    },
    reset: (): void => {
      current = { isAuthenticated: false, isLoading: true, user: null };
      listeners.forEach((l) => l());
    },
    subscribe: (cb: () => void): (() => void) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    signinRedirect: vi.fn().mockResolvedValue(undefined),
    signoutRedirect: vi.fn().mockResolvedValue(undefined),
    removeUser: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("react-oidc-context", async () => {
  const ReactMod = await import("react");
  return {
    AuthProvider: ({ children }: { children: React.ReactNode }) =>
      ReactMod.createElement(ReactMod.Fragment, null, children),
    useAuth: () => {
      ReactMod.useSyncExternalStore(
        oidcHarness.subscribe,
        oidcHarness.getState,
        oidcHarness.getState,
      );
      const snap = oidcHarness.getState();
      return {
        ...snap,
        signinRedirect: oidcHarness.signinRedirect,
        signoutRedirect: oidcHarness.signoutRedirect,
        removeUser: oidcHarness.removeUser,
      };
    },
  };
});

const mockGetTokenUserInfo = vi.fn();

vi.mock("@c7-digital/ledger/lite", () => ({
  Ledger: class {
    getTokenUserInfo = mockGetTokenUserInfo;
  },
}));

// ---------------------------------------------------------------------------
// JWT helpers — jose.decodeJwt only base64-decodes, so unsigned tokens work.
// ---------------------------------------------------------------------------

const base64url = (s: string): string =>
  Buffer.from(s)
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

const makeJwt = (payload: Record<string, unknown>): string => {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64url(JSON.stringify(payload));
  return `${header}.${body}.signature`;
};

const TOKEN_FUTURE = makeJwt({
  sub: "alice",
  exp: Math.floor(Date.now() / 1000) + 60 * 60, // +1h
});
const TOKEN_PAST = makeJwt({
  sub: "alice",
  exp: Math.floor(Date.now() / 1000) - 60, // -1m
});

// ---------------------------------------------------------------------------
// Test harness: probe that exposes useAuth() values for assertions, plus a
// fresh sessionStorage between tests.
// ---------------------------------------------------------------------------

const STORAGE_KEY = "auth_credentials_test";

const Probe: React.FC<{ onRender?: (auth: ReturnType<typeof useAuth>) => void }> = ({
  onRender,
}) => {
  const auth = useAuth();
  onRender?.(auth);
  return (
    <div>
      <span data-testid="party">{auth.credentials?.party ?? "none"}</span>
      <span data-testid="token">{auth.credentials?.token ?? "none"}</span>
      <span data-testid="source">{auth.credentials?.source ?? "none"}</span>
      <span data-testid="is-auth">{String(auth.isAuthenticated)}</span>
      <span data-testid="is-deriving">{String(auth.isDerivingCredentials)}</span>
      <span data-testid="derivation-error">
        {auth.derivationError ? auth.derivationError.message : "none"}
      </span>
      <button onClick={auth.logout}>logout</button>
      <button
        onClick={() =>
          auth.setCredentials({
            party: "manual-party",
            token: TOKEN_FUTURE,
            // Cast — real consumers pass a Ledger User; the field is opaque to us.
            user: { primaryParty: "manual-party" } as never,
          })
        }
      >
        inject-manual
      </button>
    </div>
  );
};

const renderProvider = () =>
  render(
    <AuthProvider
      oidcAuthority="https://idp.example"
      oidcClientId="my-client"
      httpBaseUrl="http://localhost:7575"
      storageKey={STORAGE_KEY}
    >
      <Probe />
    </AuthProvider>,
  );

let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  window.sessionStorage.clear();
  oidcHarness.reset();
  oidcHarness.signinRedirect.mockClear();
  oidcHarness.signoutRedirect.mockClear();
  oidcHarness.removeUser.mockClear();
  mockGetTokenUserInfo.mockReset();
  // The derive effect's .catch() logs failed derivations to console.error;
  // several tests deliberately put OIDC into a state where derive would
  // fail (no mockResolved... set) to simulate a torn-down session. Silence
  // those expected log lines so the test output stays clean.
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  consoleErrorSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AuthProvider — derive effect", () => {
  it("derives credentials from the OIDC user once authentication completes", async () => {
    mockGetTokenUserInfo.mockResolvedValueOnce({
      id: "alice",
      primaryParty: "alice::1220abcd",
    });

    renderProvider();
    expect(screen.getByTestId("party").textContent).toBe("none");

    act(() => {
      oidcHarness.setState({
        isLoading: false,
        isAuthenticated: true,
        user: { access_token: TOKEN_FUTURE },
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId("party").textContent).toBe("alice::1220abcd");
    });
    expect(screen.getByTestId("source").textContent).toBe("oidc");
    expect(screen.getByTestId("token").textContent).toBe(TOKEN_FUTURE);
    expect(screen.getByTestId("derivation-error").textContent).toBe("none");
  });

  it("surfaces a derivation failure as derivationError so apps can render it", async () => {
    // Models the production failure mode: the IdP issues a token with a `sub`
    // that does not exist as a Daml user, so GET /v2/users/{sub} comes back
    // with "not authorized" / "not found" and `getTokenUserInfo()` rejects.
    // Before v0.0.22 the error was logged to console only and the UI silently
    // bounced back to "sign in".
    mockGetTokenUserInfo.mockRejectedValueOnce(
      new Error("User 'joe' is not authorized"),
    );

    renderProvider();

    act(() => {
      oidcHarness.setState({
        isLoading: false,
        isAuthenticated: true,
        user: { access_token: TOKEN_FUTURE, profile: { sub: "joe" } },
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId("derivation-error").textContent).toBe(
        "User 'joe' is not authorized",
      );
    });
    expect(screen.getByTestId("party").textContent).toBe("none");
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("clears derivationError on logout", async () => {
    mockGetTokenUserInfo.mockRejectedValueOnce(new Error("nope"));

    renderProvider();
    act(() => {
      oidcHarness.setState({
        isLoading: false,
        isAuthenticated: true,
        user: { access_token: TOKEN_FUTURE, id_token: "id-token-here" },
      });
    });
    await waitFor(() =>
      expect(screen.getByTestId("derivation-error").textContent).toBe("nope"),
    );

    act(() => {
      screen.getByText("logout").click();
    });

    await waitFor(() =>
      expect(screen.getByTestId("derivation-error").textContent).toBe("none"),
    );
  });

  it("clears isDerivingCredentials when a derivation is cancelled mid-flight by manual setCredentials", async () => {
    // Regression for the "stuck isDerivingCredentials" path Copilot flagged
    // on PR #42: when the user manually injects credentials while the OIDC
    // derive promise is still in flight, the derive effect re-runs, the
    // cancelled-guard short-circuits the .finally setIsDerivingCredentials,
    // and the flag is stuck true until the next successful derivation.
    // Resolved via the attempt-stamp ref: only the latest attempt clears the
    // flag, but a cancelled attempt whose stamp is still current (no fresh
    // attempt ever started, because the manual write satisfied the
    // "credentials present" predicate) still gets to clear it.
    let resolveOidcLookup: ((v: { id: string; primaryParty: string }) => void)
      | undefined;
    mockGetTokenUserInfo.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOidcLookup = resolve;
        }),
    );

    renderProvider();

    // Kick off a derivation we won't let resolve right away.
    act(() => {
      oidcHarness.setState({
        isLoading: false,
        isAuthenticated: true,
        user: { access_token: TOKEN_FUTURE },
      });
    });
    await waitFor(() =>
      expect(screen.getByTestId("is-deriving").textContent).toBe("true"),
    );

    // Manual injection while the OIDC derive promise is still pending.
    act(() => {
      screen.getByText("inject-manual").click();
    });
    expect(screen.getByTestId("party").textContent).toBe("manual-party");

    // Now let the dangling derive resolve. The .finally must still clear the
    // flag — otherwise isDerivingCredentials would be stuck on "true".
    act(() => {
      resolveOidcLookup?.({ id: "alice", primaryParty: "alice::1220abcd" });
    });
    await waitFor(() =>
      expect(screen.getByTestId("is-deriving").textContent).toBe("false"),
    );
    // The cancelled .then was a no-op, so the manual credentials survive.
    expect(screen.getByTestId("party").textContent).toBe("manual-party");
  });

  it("clears derivationError when credentials are injected manually", async () => {
    mockGetTokenUserInfo.mockRejectedValueOnce(new Error("nope"));

    renderProvider();
    act(() => {
      oidcHarness.setState({
        isLoading: false,
        isAuthenticated: true,
        user: { access_token: TOKEN_FUTURE },
      });
    });
    await waitFor(() =>
      expect(screen.getByTestId("derivation-error").textContent).toBe("nope"),
    );

    act(() => {
      screen.getByText("inject-manual").click();
    });

    expect(screen.getByTestId("derivation-error").textContent).toBe("none");
    expect(screen.getByTestId("party").textContent).toBe("manual-party");
  });
});

describe("AuthProvider — token mirror effect", () => {
  it("updates credentials.token when OIDC rotates the access_token", async () => {
    mockGetTokenUserInfo.mockResolvedValueOnce({
      id: "alice",
      primaryParty: "alice::1220abcd",
    });

    renderProvider();

    act(() => {
      oidcHarness.setState({
        isLoading: false,
        isAuthenticated: true,
        user: { access_token: TOKEN_FUTURE },
      });
    });
    await waitFor(() =>
      expect(screen.getByTestId("token").textContent).toBe(TOKEN_FUTURE),
    );

    const ROTATED = makeJwt({
      sub: "alice",
      exp: Math.floor(Date.now() / 1000) + 7200,
    });
    act(() => {
      oidcHarness.setState({
        user: { access_token: ROTATED },
      });
    });

    await waitFor(() =>
      expect(screen.getByTestId("token").textContent).toBe(ROTATED),
    );
    // Party/source preserved across rotation.
    expect(screen.getByTestId("party").textContent).toBe("alice::1220abcd");
    expect(screen.getByTestId("source").textContent).toBe("oidc");
  });
});

describe("AuthProvider — logout ordering", () => {
  it("does NOT call removeUser before signoutRedirect (Keycloak needs id_token_hint)", async () => {
    mockGetTokenUserInfo.mockResolvedValueOnce({
      id: "alice",
      primaryParty: "alice::1220abcd",
    });

    renderProvider();
    act(() => {
      oidcHarness.setState({
        isLoading: false,
        isAuthenticated: true,
        user: { access_token: TOKEN_FUTURE, id_token: "id-token-here" },
      });
    });
    await waitFor(() =>
      expect(screen.getByTestId("party").textContent).toBe("alice::1220abcd"),
    );

    act(() => {
      screen.getByText("logout").click();
    });

    expect(oidcHarness.signoutRedirect).toHaveBeenCalledTimes(1);
    expect(oidcHarness.removeUser).not.toHaveBeenCalled();
    // Local credentials are cleared even before the redirect lands.
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});

describe("AuthProvider — stale credential invalidation", () => {
  it("clears OIDC-sourced credentials when OIDC settles into a not-authenticated state", async () => {
    // Seed sessionStorage as if a previous tab persisted OIDC credentials.
    const stale: Credentials = {
      party: "alice::stale",
      token: TOKEN_FUTURE, // still in-window, so JWT watchdog doesn't fire
      user: { primaryParty: "alice::stale" } as never,
      source: "oidc",
    };
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(stale));

    renderProvider();
    // Hydrated from storage, so credentials are visible immediately.
    expect(screen.getByTestId("party").textContent).toBe("alice::stale");

    // OIDC layer finishes restoring and reports: no authenticated session.
    act(() => {
      oidcHarness.setState({
        isLoading: false,
        isAuthenticated: false,
        user: null,
      });
    });

    await waitFor(() =>
      expect(screen.getByTestId("party").textContent).toBe("none"),
    );
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("clears OIDC-sourced credentials when OIDC reports an error (silent renew failed)", async () => {
    const stale: Credentials = {
      party: "alice::stale",
      token: TOKEN_FUTURE,
      user: { primaryParty: "alice::stale" } as never,
      source: "oidc",
    };
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(stale));

    renderProvider();
    expect(screen.getByTestId("party").textContent).toBe("alice::stale");

    act(() => {
      oidcHarness.setState({
        isLoading: false,
        isAuthenticated: true, // could even still be "authenticated"
        user: { access_token: TOKEN_FUTURE },
        error: new Error("renewSilent failed"),
      });
    });

    await waitFor(() =>
      expect(screen.getByTestId("party").textContent).toBe("none"),
    );
  });

  it("does NOT clear manually-injected credentials when OIDC is unauthenticated", async () => {
    const manual: Credentials = {
      party: "manual-party",
      token: TOKEN_FUTURE,
      user: { primaryParty: "manual-party" } as never,
      source: "manual",
    };
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(manual));

    renderProvider();
    expect(screen.getByTestId("party").textContent).toBe("manual-party");

    act(() => {
      oidcHarness.setState({
        isLoading: false,
        isAuthenticated: false,
        user: null,
      });
    });

    // Give the invalidation effect a tick — credentials should remain.
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByTestId("party").textContent).toBe("manual-party");
    expect(screen.getByTestId("source").textContent).toBe("manual");
  });

  it("does NOT clear credentials while OIDC is still loading", async () => {
    const stale: Credentials = {
      party: "alice::stale",
      token: TOKEN_FUTURE,
      user: { primaryParty: "alice::stale" } as never,
      source: "oidc",
    };
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(stale));

    renderProvider();
    // Default oidc state: isLoading=true. Credentials must remain so the UI
    // doesn't flicker into a login screen while OIDC is still restoring.
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByTestId("party").textContent).toBe("alice::stale");
  });
});

describe("AuthProvider — JWT exp watchdog", () => {
  it("drops credentials whose token is already expired on mount", async () => {
    const expired: Credentials = {
      party: "alice::stale",
      token: TOKEN_PAST,
      user: { primaryParty: "alice::stale" } as never,
      source: "manual",
    };
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(expired));

    renderProvider();

    await waitFor(() =>
      expect(screen.getByTestId("party").textContent).toBe("none"),
    );
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("CAS: a stale-fire timer callback does not null an already-rotated credential", async () => {
    // Capture the watchdog's timer callback so we can fire it after a
    // rotation has been committed — simulating the race where the macrotask
    // was queued by the runtime before the effect cleanup could clear it.
    const captured: Array<() => void> = [];
    const origSetTimeout = window.setTimeout;
    const setTimeoutSpy = vi
      .spyOn(window, "setTimeout")
      .mockImplementation(((cb: () => void, delay?: number) => {
        // Only intercept the watchdog (its delays are in the seconds-to-hours
        // range). Leave React's microtask shims and other short timers alone.
        if (typeof delay === "number" && delay > 1000) {
          captured.push(cb);
          return 0 as unknown as ReturnType<typeof setTimeout>;
        }
        return origSetTimeout(cb, delay);
      }) as typeof setTimeout);

    try {
      const now = Date.now();
      const tokenA = makeJwt({
        sub: "alice",
        exp: Math.floor(now / 1000) + 60,
      });
      const tokenB = makeJwt({
        sub: "alice",
        exp: Math.floor(now / 1000) + 3600,
      });
      const creds: Credentials = {
        party: "alice",
        token: tokenA,
        user: { primaryParty: "alice" } as never,
        source: "oidc",
      };
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(creds));

      renderProvider();
      // Watchdog runs on mount and registers one timer (for token A).
      expect(captured).toHaveLength(1);
      const tokenAWatchdog = captured[0]!;

      // Rotate to token B via the OIDC mirror path. After this, the
      // watchdog will have re-run and registered a new timer for B.
      act(() => {
        oidcHarness.setState({
          isLoading: false,
          isAuthenticated: true,
          user: { access_token: tokenB },
        });
      });
      await waitFor(() =>
        expect(screen.getByTestId("token").textContent).toBe(tokenB),
      );
      expect(captured).toHaveLength(2);

      // Manually fire token A's watchdog (simulating a queued macrotask
      // that the cleanup didn't get to in time). Without CAS this would
      // null credentials; with CAS it's a no-op because the ref now
      // points at token B.
      act(() => {
        tokenAWatchdog();
      });

      expect(screen.getByTestId("token").textContent).toBe(tokenB);
      expect(screen.getByTestId("party").textContent).toBe("alice");
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it("schedules a cleanup at exp for a still-valid token", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    const now = Date.now();
    const tokenExpSoon = makeJwt({
      sub: "alice",
      exp: Math.floor(now / 1000) + 5, // +5s
    });
    const creds: Credentials = {
      party: "alice::soon",
      token: tokenExpSoon,
      user: { primaryParty: "alice::soon" } as never,
      source: "manual",
    };
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(creds));

    renderProvider();
    expect(screen.getByTestId("party").textContent).toBe("alice::soon");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });

    expect(screen.getByTestId("party").textContent).toBe("none");
  });
});

describe("AuthProvider — sessionStorage persistence", () => {
  it("hydrates credentials from sessionStorage on initial render", () => {
    const seeded: Credentials = {
      party: "alice::seeded",
      token: TOKEN_FUTURE,
      user: { primaryParty: "alice::seeded" } as never,
      source: "manual",
    };
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(seeded));

    renderProvider();

    // No need to wait — hydration happens during the useState initializer.
    expect(screen.getByTestId("party").textContent).toBe("alice::seeded");
  });

  it("writes manually-injected credentials through to sessionStorage with source='manual'", async () => {
    renderProvider();

    act(() => {
      screen.getByText("inject-manual").click();
    });

    await waitFor(() =>
      expect(screen.getByTestId("party").textContent).toBe("manual-party"),
    );

    const stored = JSON.parse(window.sessionStorage.getItem(STORAGE_KEY)!);
    expect(stored.source).toBe("manual");
    expect(stored.party).toBe("manual-party");
  });
});
