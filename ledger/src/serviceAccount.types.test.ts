import {
  ClientCredentialsTokenSource,
  TokenRefresher,
  type ClientCredentialsOptions,
  type MintedToken,
  type RefreshFailure,
  type TokenRefresherOptions,
  type TokenRefresherStatus,
  type TokenSource,
} from "./serviceAccount";

// Compile-time checks: the tsgo typecheck (`pnpm typecheck`, and the build)
// fails this file when the service-account API stops accepting a caller's
// code, or starts accepting code it must refuse. vitest itself does not
// typecheck. The functions below are never called.

const source: TokenSource = {
  mint: async () => ({ token: "t", expiresAt: new Date() }),
};

describe("TokenRefresherOptions hooks", () => {
  it("accept sync, async and value-returning hooks", () => {
    const hooks = () => {
      const tokens: string[] = [];
      let ledger: { setToken: (token: string) => void } | null = null;
      const options: TokenRefresherOptions[] = [
        { source, onToken: () => {} },
        { source, onToken: ({ token }) => ledger?.setToken(token) },
        // Array.push returns a number.
        { source, onToken: ({ token }) => tokens.push(token) },
        { source, onToken: async () => {}, onFailure: async () => {} },
        {
          source,
          onToken: () => {},
          onFailure: ({ error, failures, retryInMs }: RefreshFailure) =>
            console.warn(error, failures, retryInMs),
        },
      ];
      ledger = null;
      // @ts-expect-error onToken is required
      const missing: TokenRefresherOptions = { source };
      return [options, missing];
    };
    expect(typeof hooks).toBe("function");
  });
});

describe("TokenSource", () => {
  it("accepts any object or class with an async mint()", () => {
    const sources = () => {
      class Custom implements TokenSource {
        mint(): Promise<MintedToken> {
          return Promise.resolve({ token: "t", expiresAt: new Date() });
        }
      }
      const fromIssuer: TokenSource = new ClientCredentialsTokenSource({
        issuer: new URL("https://issuer.example"),
        clientId: "svc",
        clientSecret: "secret",
      });
      // @ts-expect-error mint() must return a promise
      const sync: TokenSource = { mint: () => ({ token: "t", expiresAt: new Date() }) };
      // @ts-expect-error expiresAt is a Date, not epoch milliseconds
      const epoch: TokenSource = { mint: async () => ({ token: "t", expiresAt: Date.now() }) };
      return [new Custom(), fromIssuer, sync, epoch];
    };
    expect(typeof sources).toBe("function");
  });
});

describe("ClientCredentialsOptions", () => {
  it("needs a URL issuer, a client id and a client secret", () => {
    const options = () => {
      const minimal: ClientCredentialsOptions = {
        issuer: new URL("https://issuer.example"),
        clientId: "svc",
        clientSecret: "secret",
      };
      // @ts-expect-error the issuer is a URL, so a typo fails at the call site
      const stringIssuer: ClientCredentialsOptions = { ...minimal, issuer: "https://issuer.example" };
      // @ts-expect-error the client secret is required
      const noSecret: ClientCredentialsOptions = { issuer: minimal.issuer, clientId: "svc" };
      return [minimal, stringIssuer, noSecret];
    };
    expect(typeof options).toBe("function");
  });
});

describe("TokenRefresher", () => {
  it("gives the first token from start() and dates in status()", () => {
    const use = async () => {
      const refresher = new TokenRefresher({ source, onToken: () => {} });
      const first: MintedToken = await refresher.start();
      const again: MintedToken = await refresher.refreshNow();
      const status: TokenRefresherStatus = refresher.status();
      const next: Date | null = status.nextRefreshAt;
      const expires: Date | null = status.tokenExpiresAt;
      const failures: number = status.failures;
      // @ts-expect-error the next refresh can be absent
      const always: Date = status.nextRefreshAt;
      refresher.stop();
      return [first, again, next, expires, failures, always];
    };
    expect(typeof use).toBe("function");
  });
});
