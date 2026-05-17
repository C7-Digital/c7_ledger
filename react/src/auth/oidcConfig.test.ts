import { afterEach, describe, expect, it, vi } from "vitest";

import { createOidcConfig, oidcUserToLedgerAndCredentials } from "./oidcConfig";

// JWT with header {"alg":"HS256","typ":"JWT"} and payload {"sub":"alice"}.
// Only the payload matters here — jose.decodeJwt doesn't verify the sig.
const TEST_TOKEN =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJhbGljZSJ9.signature";

const mockGetTokenUserInfo = vi.fn();

vi.mock("@c7-digital/ledger/lite", () => ({
  Ledger: class {
    getTokenUserInfo = mockGetTokenUserInfo;
  },
}));

describe("createOidcConfig", () => {
  it("builds a config with the required OIDC fields", () => {
    const config = createOidcConfig(
      "https://idp.example/realms/foo",
      "my-client",
    );

    expect(config).toMatchObject({
      authority: "https://idp.example/realms/foo",
      client_id: "my-client",
      scope: "openid daml_ledger_api",
    });
    // No audience extra query params when not provided.
    expect(config).not.toHaveProperty("extraQueryParams");
  });

  it("attaches audience as an extra query param when given (Auth0-style)", () => {
    const config = createOidcConfig(
      "https://idp.example",
      "my-client",
      "https://canton.network.global",
    );

    expect(config).toMatchObject({
      extraQueryParams: { audience: "https://canton.network.global" },
    });
  });

  it("uses an explicit redirect_uri when provided", () => {
    const config = createOidcConfig(
      "https://idp.example",
      "my-client",
      undefined,
      "https://app.example/sub/path/callback",
    );

    expect(config.redirect_uri).toBe("https://app.example/sub/path/callback");
  });

  it("falls back to window.location.origin + '/' when no redirect_uri is given", () => {
    // jsdom provides window; the default location origin is http://localhost:3000
    const config = createOidcConfig("https://idp.example", "my-client");

    expect(config.redirect_uri).toBe(window.location.origin + "/");
  });
});

describe("oidcUserToLedgerAndCredentials", () => {
  afterEach(() => {
    mockGetTokenUserInfo.mockReset();
  });

  const makeOidcUser = (overrides: Partial<{ access_token: string }> = {}) =>
    ({
      access_token: TEST_TOKEN,
      profile: { sub: "alice", name: "Alice" },
      ...overrides,
    }) as never;

  it("derives credentials with source='oidc' and the user's primary party", async () => {
    mockGetTokenUserInfo.mockResolvedValueOnce({
      id: "alice",
      primaryParty: "alice::1220abcd",
    });

    const { credentials } = await oidcUserToLedgerAndCredentials(
      makeOidcUser(),
      "http://localhost:7575",
    );

    expect(credentials).toEqual({
      party: "alice::1220abcd",
      token: TEST_TOKEN,
      user: { id: "alice", primaryParty: "alice::1220abcd" },
      source: "oidc",
    });
  });

  it("throws when the ledger has no record of the token user", async () => {
    mockGetTokenUserInfo.mockResolvedValueOnce(null);

    await expect(
      oidcUserToLedgerAndCredentials(makeOidcUser(), "http://localhost:7575"),
    ).rejects.toThrow(/has no primary party/);
  });

  it("throws when the user exists but has no primary party assigned", async () => {
    mockGetTokenUserInfo.mockResolvedValueOnce({
      id: "alice",
      primaryParty: undefined,
    });

    await expect(
      oidcUserToLedgerAndCredentials(makeOidcUser(), "http://localhost:7575"),
    ).rejects.toThrow(/has no primary party/);
  });
});
