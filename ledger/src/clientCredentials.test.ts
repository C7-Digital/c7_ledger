import {
  ClientCredentialsTokenSource,
  type ClientCredentialsOptions,
} from "./clientCredentials";

const ISSUER = "https://issuer.example/realms/test";

type TokenAnswer =
  | { kind: "token"; expiresIn?: number }
  | { kind: "status"; status: number };

interface FakeIssuer {
  discoveries: () => number;
  tokenRequests: () => URLSearchParams[];
}

/** An issuer that serves discovery and answers token requests in order. */
function fakeIssuer(
  issuer: string,
  answers: TokenAnswer[],
  discoveryStatuses: number[] = [],
): FakeIssuer {
  let discoveries = 0;
  const tokenRequests: URLSearchParams[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === `${issuer}/.well-known/openid-configuration`) {
        const status = discoveryStatuses[discoveries] ?? 200;
        discoveries += 1;
        if (status !== 200) return new Response("unavailable", { status });
        return Response.json({
          issuer,
          token_endpoint: `${issuer}/protocol/openid-connect/token`,
        });
      }
      if (url === `${issuer}/protocol/openid-connect/token`) {
        tokenRequests.push(new URLSearchParams(String(init?.body)));
        const answer = answers[tokenRequests.length - 1] ?? { kind: "token" };
        if (answer.kind === "status") {
          return Response.json(
            { error: "unauthorized_client" },
            { status: answer.status },
          );
        }
        return Response.json({
          access_token: `token-${tokenRequests.length}`,
          token_type: "Bearer",
          ...(answer.expiresIn === undefined
            ? {}
            : { expires_in: answer.expiresIn }),
        });
      }
      return new Response("not found", { status: 404 });
    }),
  );
  return { discoveries: () => discoveries, tokenRequests: () => tokenRequests };
}

function source(
  extra: Partial<ClientCredentialsOptions> = {},
): ClientCredentialsTokenSource {
  return new ClientCredentialsTokenSource({
    issuer: new URL(ISSUER),
    clientId: "svc",
    clientSecret: "test-secret",
    ...extra,
  });
}

describe("ClientCredentialsTokenSource", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("finds the token endpoint by discovery and returns the token with its expiry", async () => {
    const issuer = fakeIssuer(ISSUER, [{ kind: "token", expiresIn: 300 }]);
    const before = Date.now();
    const minted = await source().mint();
    expect(minted.token).toBe("token-1");
    // expiresIn() counts down from the response, in whole seconds.
    expect(minted.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 299_000);
    expect(minted.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 300_000);
    expect(issuer.tokenRequests()[0]?.get("grant_type")).toBe(
      "client_credentials",
    );
  });

  it("discovers once for many tokens", async () => {
    const issuer = fakeIssuer(ISSUER, [
      { kind: "token", expiresIn: 300 },
      { kind: "token", expiresIn: 300 },
    ]);
    const s = source();
    await s.mint();
    await s.mint();
    expect(issuer.discoveries()).toBe(1);
    expect(issuer.tokenRequests()).toHaveLength(2);
  });

  it("discovers again on the next mint after a failed discovery", async () => {
    const issuer = fakeIssuer(ISSUER, [{ kind: "token", expiresIn: 300 }], [502]);
    const s = source();
    await expect(s.mint()).rejects.toThrow(
      `OIDC discovery to ${ISSUER} failed: 502`,
    );
    await expect(s.mint()).resolves.toMatchObject({ token: "token-1" });
    expect(issuer.discoveries()).toBe(2);
  });

  it("sends the audience and the scope when they are set", async () => {
    const issuer = fakeIssuer(ISSUER, [{ kind: "token", expiresIn: 300 }]);
    await source({ audience: "https://ledger.example", scope: "daml_ledger_api" }).mint();
    const body = issuer.tokenRequests()[0];
    expect(body?.get("audience")).toBe("https://ledger.example");
    expect(body?.get("scope")).toBe("daml_ledger_api");
  });

  it("sends no audience when it is not set", async () => {
    const issuer = fakeIssuer(ISSUER, [{ kind: "token", expiresIn: 300 }]);
    await source().mint();
    expect(issuer.tokenRequests()[0]?.has("audience")).toBe(false);
  });

  it("rejects a token response without expires_in", async () => {
    fakeIssuer(ISSUER, [{ kind: "token" }]);
    await expect(source().mint()).rejects.toThrow("no positive expires_in");
  });

  it("rejects rejected client credentials", async () => {
    fakeIssuer(ISSUER, [{ kind: "status", status: 401 }]);
    await expect(source().mint()).rejects.toThrow(
      "OIDC token request to https://issuer.example/realms/test failed: 401 unauthorized_client",
    );
  });

  it("names the network cause when the issuer cannot be reached", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw Object.assign(new TypeError("fetch failed"), {
          cause: { code: "ECONNREFUSED" },
        });
      }),
    );
    await expect(source().mint()).rejects.toThrow(
      `OIDC discovery to ${ISSUER} failed: fetch failed (ECONNREFUSED)`,
    );
  });

  it("refuses an http issuer unless insecure http is allowed", async () => {
    const http = "http://localhost:8080/realms/test";
    fakeIssuer(http, [{ kind: "token", expiresIn: 300 }]);
    await expect(source({ issuer: new URL(http) }).mint()).rejects.toThrow(
      /HTTPS/,
    );
    await expect(
      source({ issuer: new URL(http), allowInsecureHttp: true }).mint(),
    ).resolves.toMatchObject({ token: "token-1" });
  });
});
