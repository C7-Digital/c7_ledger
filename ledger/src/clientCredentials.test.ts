import {
  ClientCredentialsTokenSource,
  type ClientCredentialsOptions,
} from "./clientCredentials";
import type { MintedToken } from "./tokenRefresher";

const ISSUER = "https://issuer.example/realms/test";
const HTTP_ISSUER = "http://localhost:8080/realms/test";
const TOKEN_PATH = "/protocol/openid-connect/token";

/** The client authentication methods that Keycloak lists. */
const KEYCLOAK_AUTH_METHODS = ["client_secret_basic", "client_secret_post"];

/** One answer from the fake issuer. */
type Answer =
  | { kind: "json"; status: number; body: Record<string, unknown> }
  | { kind: "text"; status: number; body: string }
  | { kind: "network"; code: string };

/** A valid token answer, with fields added or replaced. */
function tokenAnswer(fields: Record<string, unknown> = {}): Answer {
  return {
    kind: "json",
    status: 200,
    body: { access_token: "token", token_type: "Bearer", expires_in: 300, ...fields },
  };
}

/** A valid discovery answer for `issuer`, with fields added or replaced. */
function discoveryAnswer(issuer: string, fields: Record<string, unknown> = {}): Answer {
  return {
    kind: "json",
    status: 200,
    body: {
      issuer,
      token_endpoint: `${issuer}${TOKEN_PATH}`,
      token_endpoint_auth_methods_supported: KEYCLOAK_AUTH_METHODS,
      ...fields,
    },
  };
}

interface FakeIssuer {
  discoveries: () => number;
  tokenRequests: () => Array<{ body: URLSearchParams; authorization: string | null }>;
}

/**
 * An issuer that gives the discovery answers and the token answers in order.
 * After the last answer of a kind, it gives that last answer again.
 */
function fakeIssuer(
  issuer: string,
  discoveries: Answer[],
  tokens: Answer[],
): FakeIssuer {
  let discoveryCount = 0;
  const tokenRequests: Array<{ body: URLSearchParams; authorization: string | null }> = [];
  const respond = (answer: Answer): Response => {
    switch (answer.kind) {
      case "json":
        return Response.json(answer.body, { status: answer.status });
      case "text":
        return new Response(answer.body, { status: answer.status });
      case "network":
        throw Object.assign(new TypeError("fetch failed"), {
          cause: { code: answer.code },
        });
    }
  };
  const pick = (answers: Answer[], n: number): Answer => {
    const answer = answers[Math.min(n, answers.length - 1)];
    if (answer === undefined) throw new Error("the fake issuer has no answer");
    return answer;
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === `${issuer}/.well-known/openid-configuration`) {
        discoveryCount += 1;
        return respond(pick(discoveries, discoveryCount - 1));
      }
      if (url === `${issuer}${TOKEN_PATH}`) {
        tokenRequests.push({
          body: new URLSearchParams(String(init?.body)),
          authorization: new Headers(init?.headers).get("authorization"),
        });
        return respond(pick(tokens, tokenRequests.length - 1));
      }
      return new Response("not found", { status: 404 });
    }),
  );
  return { discoveries: () => discoveryCount, tokenRequests: () => tokenRequests };
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

/** Where a request that the source sends carries the client secret. */
type SecretIn = "body" | "header";

function secretIn(request: { body: URLSearchParams; authorization: string | null }): SecretIn | "both" | "none" {
  const inBody = request.body.get("client_secret") === "test-secret";
  // RFC 6749 form-encodes the id and the secret before Basic encoding.
  const inHeader = request.authorization === `Basic ${btoa("svc:test%2Dsecret")}`;
  if (inBody && inHeader) return "both";
  if (inBody) return "body";
  if (inHeader) return "header";
  return "none";
}

/** The options that a table row can set. */
interface CaseSetup {
  name: string;
  issuer?: string;
  allowInsecureHttp?: boolean;
  discovery?: Answer;
  token?: Answer;
}

/** An issuer behavior for which the source must return a token. */
interface MintCase extends CaseSetup {
  secretIn: SecretIn;
  lifetimeSeconds: number;
}

/** An issuer behavior for which the source must fail with this error. */
interface FailCase extends CaseSetup {
  fails: string | RegExp;
}

const OPENID = (s: string): string => `OIDC discovery to ${ISSUER} failed: ${s}`;
const TOKEN = (s: string): string => `OIDC token request to ${ISSUER} failed: ${s}`;

/** Issuer behaviors that the OAuth 2.0 and OpenID Connect standards allow, or that real issuers show. */
const MINT_CASES: MintCase[] = [
  // Client authentication (RFC 8414 token_endpoint_auth_methods_supported).
  { name: "issuer lists both secret methods (Keycloak)", secretIn: "body", lifetimeSeconds: 300 },
  {
    name: "issuer lists only client_secret_post",
    discovery: discoveryAnswer(ISSUER, { token_endpoint_auth_methods_supported: ["client_secret_post"] }),
    secretIn: "body",
    lifetimeSeconds: 300,
  },
  {
    name: "issuer lists only client_secret_basic",
    discovery: discoveryAnswer(ISSUER, { token_endpoint_auth_methods_supported: ["client_secret_basic"] }),
    secretIn: "header",
    lifetimeSeconds: 300,
  },
  {
    name: "issuer lists no methods (the RFC 8414 default is client_secret_basic)",
    discovery: discoveryAnswer(ISSUER, { token_endpoint_auth_methods_supported: undefined }),
    secretIn: "header",
    lifetimeSeconds: 300,
  },
  // Token lifetime (RFC 6749 expires_in).
  {
    name: "expires_in of ten years",
    token: tokenAnswer({ expires_in: 315_360_000 }),
    secretIn: "body",
    lifetimeSeconds: 315_360_000,
  },
  // Some issuers send expires_in as a string; openid-client parses it.
  {
    name: "expires_in as a numeric string",
    token: tokenAnswer({ expires_in: "300" }),
    secretIn: "body",
    lifetimeSeconds: 300,
  },
  // Transport.
  {
    name: "http issuer with allowInsecureHttp",
    issuer: HTTP_ISSUER,
    allowInsecureHttp: true,
    secretIn: "body",
    lifetimeSeconds: 300,
  },
];

const FAIL_CASES: FailCase[] = [
  // Client authentication.
  {
    name: "issuer lists an empty method list",
    discovery: discoveryAnswer(ISSUER, { token_endpoint_auth_methods_supported: [] }),
    fails: OPENID("The token endpoint supports none of client_secret_post, client_secret_basic"),
  },
  {
    name: "issuer supports only private_key_jwt",
    discovery: discoveryAnswer(ISSUER, { token_endpoint_auth_methods_supported: ["private_key_jwt"] }),
    fails: "(it supports: private_key_jwt)",
  },
  // Token lifetime.
  { name: "no expires_in", token: tokenAnswer({ expires_in: undefined }), fails: "no positive expires_in" },
  { name: "expires_in 0", token: tokenAnswer({ expires_in: 0 }), fails: "no positive expires_in" },
  { name: "negative expires_in", token: tokenAnswer({ expires_in: -5 }), fails: TOKEN("") },
  {
    name: "expires_in as a string that is not a number",
    token: tokenAnswer({ expires_in: "soon" }),
    fails: TOKEN(""),
  },
  // Token response shape.
  { name: "no access_token", token: tokenAnswer({ access_token: undefined }), fails: TOKEN("") },
  { name: "token_type that is not Bearer", token: tokenAnswer({ token_type: "mac" }), fails: TOKEN("") },
  // Error answers from the token endpoint (RFC 6749 section 5.2).
  {
    name: "400 invalid_client with a description",
    token: {
      kind: "json",
      status: 400,
      body: { error: "invalid_client", error_description: "Invalid client secret" },
    },
    fails: TOKEN("400 invalid_client Invalid client secret"),
  },
  {
    name: "401 unauthorized_client",
    token: { kind: "json", status: 401, body: { error: "unauthorized_client" } },
    fails: TOKEN("401 unauthorized_client"),
  },
  {
    name: "503 with a text body",
    token: { kind: "text", status: 503, body: "Service Unavailable" },
    fails: TOKEN("503"),
  },
  {
    name: "token endpoint cannot be reached",
    token: { kind: "network", code: "ECONNREFUSED" },
    fails: TOKEN("fetch failed (ECONNREFUSED)"),
  },
  // Discovery (OpenID Connect Discovery 1.0).
  {
    name: "discovery answers 404",
    discovery: { kind: "text", status: 404, body: "not found" },
    fails: OPENID("404"),
  },
  {
    name: "discovery cannot be reached",
    discovery: { kind: "network", code: "ENOTFOUND" },
    fails: OPENID("fetch failed (ENOTFOUND)"),
  },
  {
    name: "discovery names a different issuer",
    discovery: discoveryAnswer(ISSUER, { issuer: "https://other.example/realms/test" }),
    fails: OPENID(""),
  },
  {
    name: "discovery has no token_endpoint",
    discovery: discoveryAnswer(ISSUER, { token_endpoint: undefined }),
    fails: TOKEN(""),
  },
  // Transport.
  { name: "http issuer without allowInsecureHttp", issuer: HTTP_ISSUER, fails: /HTTPS/ },
];

/** Starts a mint from a source that talks to the fake issuer of `c`. */
function mintFor(c: CaseSetup): { fake: FakeIssuer; minting: Promise<MintedToken> } {
  const issuer = c.issuer ?? ISSUER;
  const fake = fakeIssuer(issuer, [c.discovery ?? discoveryAnswer(issuer)], [c.token ?? tokenAnswer()]);
  const minting = source({
    issuer: new URL(issuer),
    ...(c.allowInsecureHttp ? { allowInsecureHttp: true } : {}),
  }).mint();
  return { fake, minting };
}

describe("ClientCredentialsTokenSource issuer conformance", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(MINT_CASES)("gets a token: $name", async (c) => {
    const before = Date.now();
    const { fake, minting } = mintFor(c);
    const minted = await minting;
    const request = fake.tokenRequests()[0];
    expect(minted.token).toBe("token");
    expect(request?.body.get("grant_type")).toBe("client_credentials");
    expect(request && secretIn(request)).toBe(c.secretIn);
    // expiresIn() counts down in whole seconds.
    const lifetimeMs = c.lifetimeSeconds * 1000;
    expect(minted.expiresAt.getTime()).toBeGreaterThanOrEqual(before + lifetimeMs - 1000);
    expect(minted.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + lifetimeMs);
  });

  it.each(FAIL_CASES)("fails: $name", async (c) => {
    await expect(mintFor(c).minting).rejects.toThrow(c.fails);
  });
});

describe("ClientCredentialsTokenSource", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("discovers once for many tokens", async () => {
    const issuer = fakeIssuer(ISSUER, [discoveryAnswer(ISSUER)], [tokenAnswer()]);
    const s = source();
    await s.mint();
    await s.mint();
    expect(issuer.discoveries()).toBe(1);
    expect(issuer.tokenRequests()).toHaveLength(2);
  });

  it("discovers again on the next mint after a failed discovery", async () => {
    const issuer = fakeIssuer(
      ISSUER,
      [{ kind: "text", status: 502, body: "unavailable" }, discoveryAnswer(ISSUER)],
      [tokenAnswer()],
    );
    const s = source();
    await expect(s.mint()).rejects.toThrow(OPENID("502"));
    await expect(s.mint()).resolves.toMatchObject({ token: "token" });
    expect(issuer.discoveries()).toBe(2);
  });

  it("sends the audience and the scope when they are set", async () => {
    const issuer = fakeIssuer(ISSUER, [discoveryAnswer(ISSUER)], [tokenAnswer()]);
    await source({ audience: "https://ledger.example", scope: "daml_ledger_api" }).mint();
    const body = issuer.tokenRequests()[0]?.body;
    expect(body?.get("audience")).toBe("https://ledger.example");
    expect(body?.get("scope")).toBe("daml_ledger_api");
  });

  it("sends no audience and no scope when they are not set", async () => {
    const issuer = fakeIssuer(ISSUER, [discoveryAnswer(ISSUER)], [tokenAnswer()]);
    await source().mint();
    const body = issuer.tokenRequests()[0]?.body;
    expect(body?.has("audience")).toBe(false);
    expect(body?.has("scope")).toBe(false);
  });
});
