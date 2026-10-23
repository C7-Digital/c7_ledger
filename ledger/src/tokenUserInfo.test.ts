// The token user's rights decide the default actAs/readAs of every call, so a
// right that the participant revokes or grants must reach those calls.
import { Ledger } from "./ledger";

// Header: {"alg":"HS256","typ":"JWT"}
// Payload: {"sub":"test-user","iat":1516239022}
const TEST_TOKEN =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0ZXN0LXVzZXIiLCJpYXQiOjE1MTYyMzkwMjJ9.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
// Header: {"alg":"HS256","typ":"JWT"}
// Payload: {"sub":"other-user","iat":1516239022}
const OTHER_TOKEN =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJvdGhlci11c2VyIiwiaWF0IjoxNTE2MjM5MDIyfQ.c2lnbmF0dXJl";

function json(body: unknown): Response {
  const text = JSON.stringify(body);
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    text: async () => text,
    json: async () => body,
  } as unknown as Response;
}

/**
 * Stub the user endpoints. `rights[user]` is the participant's current
 * CanActAs list of each user; `reads` counts the rights reads.
 * `holdNextRightsRead` takes the next rights answer when the request
 * arrives, and returns it only when the caller releases it.
 */
function stubUsers(rights: Record<string, string[]>): {
  reads: () => number;
  holdNextRightsRead: () => () => void;
} {
  let reads = 0;
  let hold: Promise<void> | undefined;
  globalThis.fetch = (async (url: string) => {
    const path = new URL(url).pathname;
    const rightsMatch = /^\/v2\/users\/([^/]+)\/rights$/.exec(path);
    if (rightsMatch) {
      reads += 1;
      const body = {
        rights: (rights[rightsMatch[1] ?? ""] ?? []).map((party: string) => ({
          kind: { CanActAs: { value: { party } } },
        })),
      };
      const held = hold;
      hold = undefined;
      if (held) await held;
      return json(body);
    }
    const userMatch = /^\/v2\/users\/([^/]+)$/.exec(path);
    if (userMatch) {
      return json({ user: { id: userMatch[1], primaryParty: "", isDeactivated: false } });
    }
    throw new Error(`unexpected request ${path}`);
  }) as unknown as typeof fetch;
  return {
    reads: () => reads,
    holdNextRightsRead: () => {
      let release = () => {};
      hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
  };
}

function makeLedger(maxAgeMs?: number): Ledger {
  return new Ledger({
    token: TEST_TOKEN,
    httpBaseUrl: "http://localhost:7575",
    validation: "logErrors",
    tokenUserInfoMaxAgeMs: maxAgeMs,
  });
}

describe("token user rights", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it("reuses the rights inside the age limit", async () => {
    const stub = stubUsers({ "test-user": ["alice::1220"] });
    const ledger = makeLedger();
    expect(await ledger.getTokenActAsParties()).toEqual(["alice::1220"]);
    expect(await ledger.getTokenActAsParties()).toEqual(["alice::1220"]);
    expect(stub.reads()).toBe(1);
  });

  it("reads a revoked right again after the age limit", async () => {
    const rights = { "test-user": ["alice::1220", "bob::1220"] };
    stubUsers(rights);
    const ledger = makeLedger(1_000);
    const now = vi.spyOn(Date, "now").mockReturnValue(10_000);
    expect(await ledger.getTokenActAsParties()).toEqual(["alice::1220", "bob::1220"]);

    rights["test-user"] = ["alice::1220"];
    now.mockReturnValue(10_500);
    expect(await ledger.getTokenActAsParties()).toEqual(["alice::1220", "bob::1220"]);
    now.mockReturnValue(11_000);
    expect(await ledger.getTokenActAsParties()).toEqual(["alice::1220"]);
  });

  it("reads the rights now on refreshTokenUserInfo", async () => {
    const rights = { "test-user": ["alice::1220"] };
    stubUsers(rights);
    const ledger = makeLedger();
    await ledger.getTokenUserInfo();

    rights["test-user"] = ["carol::1220"];
    const user = await ledger.refreshTokenUserInfo();
    expect(user?.rights).toEqual([{ type: "canActAs", party: "carol::1220" }]);
    expect(await ledger.getTokenActAsParties()).toEqual(["carol::1220"]);
  });

  it("shares one read between concurrent callers", async () => {
    const stub = stubUsers({ "test-user": ["alice::1220"] });
    const ledger = makeLedger();
    await Promise.all([
      ledger.getTokenActAsParties(),
      ledger.getTokenActAsParties(),
      ledger.getTokenUserInfo(),
    ]);
    expect(stub.reads()).toBe(1);
  });

  it("follows the user of a new token", async () => {
    stubUsers({ "test-user": ["alice::1220"], "other-user": ["dave::1220"] });
    const ledger = makeLedger();
    expect(await ledger.getTokenActAsParties()).toEqual(["alice::1220"]);

    ledger.setToken(OTHER_TOKEN);
    expect(ledger.getTokenUserId()).toBe("other-user");
    expect(await ledger.getTokenActAsParties()).toEqual(["dave::1220"]);
  });

  it("reads the rights again after setToken for the same user", async () => {
    const rights = { "test-user": ["alice::1220"] };
    const stub = stubUsers(rights);
    const ledger = makeLedger();
    await ledger.getTokenActAsParties();

    rights["test-user"] = ["alice::1220", "erin::1220"];
    ledger.setToken(TEST_TOKEN);
    expect(await ledger.getTokenActAsParties()).toEqual(["alice::1220", "erin::1220"]);
    expect(stub.reads()).toBe(2);
  });

  it("keeps a read that a setToken overtook out of the cache", async () => {
    const rights = { "test-user": ["alice::1220"] };
    const stub = stubUsers(rights);
    const ledger = makeLedger();
    const release = stub.holdNextRightsRead();
    const before = ledger.getTokenActAsParties();
    // The held read has taken the old rights; then the token changes.
    await vi.waitFor(() => expect(stub.reads()).toBe(1));
    rights["test-user"] = ["alice::1220", "frank::1220"];
    ledger.setToken(TEST_TOKEN);
    release();
    expect(await before).toEqual(["alice::1220"]);

    expect(await ledger.getTokenActAsParties()).toEqual(["alice::1220", "frank::1220"]);
    expect(stub.reads()).toBe(2);
    expect(await ledger.getTokenActAsParties()).toEqual(["alice::1220", "frank::1220"]);
    expect(stub.reads()).toBe(2);
  });
});
