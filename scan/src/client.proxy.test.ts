import { afterEach, beforeEach, vi } from "vitest";
import { DEFAULT_COOLDOWN_MS, ScanClient, type ScanRead } from "./client.js";
import { ScanApiError, ScanProxyAuthError, ScanUnavailableError } from "./error.js";
import { logger } from "./logger.js";

// The client remembers unavailable sources and missing endpoints for each base
// URL in the process, so each test uses its own Scans and validator.
let testCount = 0;
let scanA = "";
let scanB = "";
let validator = "";
beforeEach(() => {
  testCount += 1;
  scanA = `https://scan-a-${testCount}.example.com/api/scan`;
  scanB = `https://scan-b-${testCount}.example.com/api/scan`;
  validator = `https://validator-${testCount}.example.com/api/validator`;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** What one source does with a request. */
type Behavior = { kind: "status"; status: number; body?: unknown } | { kind: "network" };

const ok = (body: unknown): Behavior => ({ kind: "status", status: 200, body });
const status = (code: number): Behavior => ({ kind: "status", status: code });

interface Call {
  source: string;
  path: string;
  method: string;
  authorization: string | null;
}

/**
 * Each source (by origin) answers with `behaviors[origin path prefix]`, or the
 * function of that key for each path. Returns the calls, in order.
 */
function stub(behaviors: Record<string, Behavior | ((path: string) => Behavior)>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const prefix = url.pathname.startsWith("/api/validator") ? "/api/validator" : "/api/scan";
    const source = `${url.origin}${prefix}`;
    const path = url.pathname.slice(prefix.length);
    const headers = new Headers(init?.headers);
    calls.push({ source, path, method: init?.method ?? "GET", authorization: headers.get("Authorization") });
    const entry = behaviors[source];
    if (entry === undefined) return Promise.reject(new Error(`no stub for ${source}`));
    const behavior = typeof entry === "function" ? entry(path) : entry;
    if (behavior.kind === "network") return Promise.reject(new TypeError("fetch failed"));
    return Promise.resolve(
      new Response(JSON.stringify(behavior.body ?? { error: "x" }), {
        status: behavior.status,
        headers: { "content-type": "application/json" },
      }),
    );
  });
  return calls;
}

const DSO = { dso_party_id: "DSO::1220aa" };
const FROM_SCAN = { dso_party_id: "DSO::fromScan" };

function client(token: () => string | undefined | Promise<string | undefined> = () => "tok-1"): ScanClient {
  return new ScanClient({ baseUrls: [scanA, scanB], validator: { baseUrl: validator, token } });
}

describe("the scan proxy: which answer of the proxy reads the Scans", () => {
  it.each<[string, Behavior, "proxy" | "scans" | "auth-error" | "answer"]>([
    ["200", ok(DSO), "proxy"],
    ["401 (the token's issuer or audience)", status(401), "auth-error"],
    ["400 (a bad request is the same everywhere)", status(400), "answer"],
    ["403", status(403), "scans"],
    ["429", status(429), "scans"],
    ["500", status(500), "scans"],
    ["503", status(503), "scans"],
    ["a network error", { kind: "network" }, "scans"],
  ])("%s → %s", async (_label, proxy, expected) => {
    const calls = stub({ [validator]: proxy, [scanA]: ok(FROM_SCAN) });
    const result = await client()
      .getDsoPartyId()
      .then(
        value => ({ value }),
        (error: unknown) => ({
          error:
            error instanceof ScanProxyAuthError
              ? "ScanProxyAuthError"
              : error instanceof ScanApiError
                ? `ScanApiError ${error.status}`
                : String(error),
        }),
      );
    const expectedResult = {
      proxy: { value: DSO },
      scans: { value: FROM_SCAN },
      "auth-error": { error: "ScanProxyAuthError" },
      answer: { error: "ScanApiError 400" },
    }[expected];
    const expectedSources = expected === "scans" ? [validator, scanA] : [validator];
    expect({ result, sources: calls.map(c => c.source) }).toEqual({
      result: expectedResult,
      sources: expectedSources,
    });
  });

  it("sends the token of each request, and calls the token function for each request", async () => {
    let n = 0;
    const calls = stub({ [validator]: ok(DSO) });
    const c = client(() => `tok-${++n}`);
    await c.getDsoPartyId();
    await c.getDsoPartyId();
    expect(calls.map(x => [x.path, x.authorization])).toEqual([
      ["/v0/scan-proxy/dso-party-id", "Bearer tok-1"],
      ["/v0/scan-proxy/dso-party-id", "Bearer tok-2"],
    ]);
  });

  it("sends no token to the Scans", async () => {
    const calls = stub({ [validator]: status(503), [scanA]: ok(FROM_SCAN) });
    await client().getDsoPartyId();
    expect(calls.map(c => [c.source, c.authorization])).toEqual([
      [validator, "Bearer tok-1"],
      [scanA, null],
    ]);
  });

  it("reads the Scans when the token function gives no token", async () => {
    const calls = stub({ [scanA]: ok(FROM_SCAN) });
    await expect(client(async () => undefined).getDsoPartyId()).resolves.toEqual(FROM_SCAN);
    expect(calls.map(c => c.source)).toEqual([scanA]);
  });

  it("gives the error of a token function that throws, and sends no request", async () => {
    const calls = stub({ [scanA]: ok(FROM_SCAN) });
    const failing = client(() => {
      throw new Error("not signed in");
    });
    await expect(failing.getDsoPartyId()).rejects.toThrow("not signed in");
    expect(calls).toEqual([]);
  });

  it("logs each fallback to the Scans, and reads the Scans first while the proxy cools down", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-07T12:00:00Z"));
    const warn = vi.spyOn(logger, "warn");
    const calls = stub({ [validator]: status(503), [scanA]: ok(FROM_SCAN) });
    const c = client();
    await c.getDsoPartyId();
    await c.getDsoPartyId();
    expect(calls.map(x => x.source)).toEqual([validator, scanA, scanA]);
    const fallbacks = warn.mock.calls.map(args => String(args[0])).filter(m => m.includes("reading /v0/scan-proxy"));
    expect(fallbacks).toHaveLength(2);

    vi.setSystemTime(Date.now() + DEFAULT_COOLDOWN_MS + 1);
    calls.length = 0;
    await c.getDsoPartyId();
    expect(calls.map(x => x.source)).toEqual([validator, scanA]);
  });

  it("names the proxy as the first attempt when no source answers", async () => {
    stub({ [validator]: status(503), [scanA]: status(403), [scanB]: { kind: "network" } });
    const error = await client().getDsoPartyId().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ScanUnavailableError);
    expect((error as ScanUnavailableError).attempts.map(a => a.baseUrl)).toEqual([validator, scanA, scanB]);
  });

  it("never calls the proxy without a validator in the config", async () => {
    const calls = stub({ [scanA]: ok(FROM_SCAN) });
    await new ScanClient({ baseUrls: [scanA] }).getDsoPartyId();
    expect(calls.map(c => c.source)).toEqual([scanA]);
  });

  it("works with one Scan and a proxy", async () => {
    const calls = stub({ [validator]: status(502), [scanA]: ok(FROM_SCAN) });
    const c = new ScanClient({ baseUrl: scanA, validator: { baseUrl: validator, token: () => "t" } });
    await expect(c.getDsoPartyId()).resolves.toEqual(FROM_SCAN);
    expect(calls.map(x => x.source)).toEqual([validator, scanA]);
  });
});

describe("the scan proxy and 404", () => {
  it("gives a 404 of a lookup as the answer, and does not read the Scans", async () => {
    const calls = stub({ [validator]: status(404), [scanA]: ok({}) });
    const error = await client().lookupFeaturedAppRight("p::1").catch((e: unknown) => e);
    expect((error as ScanApiError).status).toBe(404);
    expect(calls.map(c => c.source)).toEqual([validator]);
  });

  it("reads the Scans when the validator does not serve the path (an older Splice line), and remembers it", async () => {
    const DSO_V1 = { dso_party_id: "DSO::1220aa", voting_threshold: 3, sv_node_states: [] };
    const calls = stub({ [validator]: status(404), [scanA]: ok(DSO_V1) });
    const c = client();
    await expect(c.getDsoInfoV1()).resolves.toEqual(DSO_V1);
    expect(calls.map(x => `${x.source === validator ? "proxy" : "scan"}${x.path}`)).toEqual([
      "proxy/v1/scan-proxy/dso",
      "scan/v1/dso",
    ]);
    calls.length = 0;
    await c.getDsoInfoV1();
    expect(calls.map(x => x.source)).toEqual([scanA]);
  });
});

describe("reads that the proxy and Scan answer in different shapes", () => {
  const contract = (id: string) => ({
    template_id: "pkg:Splice.Round:OpenMiningRound",
    contract_id: id,
    payload: {},
    created_event_blob: "blob",
    created_at: "2026-11-07T00:00:00Z",
  });

  it("getCurrentMiningRounds reads the proxy (arrays)", async () => {
    const rounds = { open_mining_rounds: [{ contract: contract("o1"), domain_id: "d" }], issuing_mining_rounds: [] };
    const calls = stub({ [validator]: ok(rounds) });
    await expect(client().getCurrentMiningRounds()).resolves.toEqual(rounds);
    expect(calls.map(c => [c.method, c.path])).toEqual([["GET", "/v0/scan-proxy/open-and-issuing-mining-rounds"]]);
  });

  it("getCurrentMiningRounds without a proxy reads Scan with an empty cache and gives the same shape", async () => {
    const seen: unknown[] = [];
    vi.stubGlobal("fetch", async (_input: string, init?: RequestInit) => {
      seen.push(JSON.parse(String(init?.body)));
      return new Response(
        JSON.stringify({
          time_to_live_in_microseconds: 1,
          open_mining_rounds: { o1: { contract: contract("o1"), domain_id: "d" }, o2: { domain_id: "d" } },
          issuing_mining_rounds: { i1: { contract: contract("i1") } },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const rounds = await new ScanClient({ baseUrl: scanA }).getCurrentMiningRounds();
    expect(seen).toEqual([{ cached_open_mining_round_contract_ids: [], cached_issuing_round_contract_ids: [] }]);
    expect(rounds).toEqual({
      open_mining_rounds: [{ contract: contract("o1"), domain_id: "d" }],
      issuing_mining_rounds: [{ contract: contract("i1"), domain_id: undefined }],
    });
  });

  it("getCurrentAmuletRules reads the proxy, or Scan without a proxy, in the proxy's shape", async () => {
    const rules = { contract: contract("r1"), domain_id: "d" };
    stub({ [validator]: ok({ amulet_rules: rules }), [scanA]: ok({ amulet_rules_update: rules }) });
    await expect(client().getCurrentAmuletRules()).resolves.toEqual({ amulet_rules: rules });
    await expect(new ScanClient({ baseUrl: scanA }).getCurrentAmuletRules()).resolves.toEqual({ amulet_rules: rules });
  });

  it("the Scan-shaped twins read only the Scans, with the caller's cache", async () => {
    const calls = stub({ [scanA]: ok({ open_mining_rounds: {}, issuing_mining_rounds: {} }) });
    await client().getOpenAndIssuingMiningRounds({
      cached_open_mining_round_contract_ids: ["o1"],
      cached_issuing_round_contract_ids: [],
    });
    expect(calls.map(c => [c.source, c.method, c.path])).toEqual([[scanA, "POST", "/v0/open-and-issuing-mining-rounds"]]);
  });
});

describe("onRead", () => {
  it("reports the source of each read", async () => {
    stub({ [validator]: (path: string) => (path.endsWith("dso-party-id") ? status(503) : ok({})), [scanA]: ok(FROM_SCAN) });
    const reads: ScanRead[] = [];
    const c = new ScanClient({
      baseUrls: [scanA],
      validator: { baseUrl: validator, token: () => "t" },
      cooldownMs: 0,
      onRead: r => reads.push(r),
    });
    await c.getDsoPartyId();
    await c.lookupFeaturedAppRight("p::1");
    expect(reads).toEqual([
      { path: "/v0/dso-party-id", source: "scan", baseUrl: scanA },
      { path: "/v0/scan-proxy/featured-apps/p%3A%3A1", source: "proxy", baseUrl: validator },
    ]);
  });

  it("does not change the read when the hook throws", async () => {
    stub({ [validator]: ok(DSO) });
    const c = new ScanClient({
      baseUrl: scanA,
      validator: { baseUrl: validator, token: () => "t" },
      onRead: () => {
        throw new Error("hook bug");
      },
    });
    await expect(c.getDsoPartyId()).resolves.toEqual(DSO);
  });
});
