import { afterEach, beforeEach, vi } from "vitest";
import { ScanClient, DEFAULT_COOLDOWN_MS, isScanUnavailable, type ScanBaseUrls } from "./client.js";
import { ScanApiError, ScanUnavailableError } from "./error.js";

// The client remembers unavailable Scans and missing endpoints for each base
// URL in the process, so each test uses its own Scans.
let testCount = 0;
let scanA = "";
let scanB = "";
let scanC = "";
beforeEach(() => {
  testCount += 1;
  scanA = `https://scan-a-${testCount}.example.com/api/scan`;
  scanB = `https://scan-b-${testCount}.example.com/api/scan`;
  scanC = `https://scan-c-${testCount}.example.com/api/scan`;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** What one Scan does with a request. */
type Behavior =
  | { kind: "status"; status: number; body?: unknown }
  | { kind: "network" }
  | { kind: "hang" };

const ok = (body: unknown): Behavior => ({ kind: "status", status: 200, body });
const status = (code: number): Behavior => ({ kind: "status", status: code });

const DSO_PARTY = { dso_party_id: "DSO::1220aa" };

/**
 * Each Scan (by origin) answers with its behavior. Returns the origins of the
 * calls, in order.
 */
function stubScans(behaviors: Record<string, Behavior>): string[] {
  const calls: string[] = [];
  vi.stubGlobal("fetch", (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const base = `${url.origin}/api/scan`;
    calls.push(base);
    const behavior = behaviors[base];
    if (behavior === undefined) throw new Error(`no stub for ${base}`);
    switch (behavior.kind) {
      case "network":
        return Promise.reject(new TypeError("fetch failed"));
      case "hang":
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
        });
      case "status":
        return Promise.resolve(
          new Response(JSON.stringify(behavior.body ?? { error: "x" }), {
            status: behavior.status,
            headers: { "content-type": "application/json" },
          }),
        );
    }
  });
  return calls;
}

describe("a list of Scans: which answer of the first Scan moves on to the next Scan", () => {
  it.each<[string, Behavior, "next" | "answer"]>([
    ["200", ok(DSO_PARTY), "answer"],
    ["400 (a bad request is the same on every Scan)", status(400), "answer"],
    ["404 (not found is the network's answer)", status(404), "answer"],
    ["409", status(409), "answer"],
    ["401 (a gateway in front of the Scan)", status(401), "next"],
    ["403 (an IP allowlist)", status(403), "next"],
    ["408", status(408), "next"],
    ["429 (rate limit)", status(429), "next"],
    ["500", status(500), "next"],
    ["502", status(502), "next"],
    ["503", status(503), "next"],
    ["504", status(504), "next"],
    ["a network error, CORS refusal or DNS failure", { kind: "network" }, "next"],
  ])("%s → %s", async (_label, first, expected) => {
    const calls = stubScans({ [scanA]: first, [scanB]: ok({ dso_party_id: "DSO::fromB" }) });
    const client = new ScanClient({ baseUrls: [scanA, scanB] });
    const result = await client.getDsoPartyId().then(
      value => ({ value }),
      (error: unknown) => ({ error: error instanceof ScanApiError ? `ScanApiError ${error.status}` : String(error) }),
    );
    const firstAnswer =
      first.kind === "status" && first.status === 200
        ? { value: DSO_PARTY }
        : { error: `ScanApiError ${first.kind === "status" ? first.status : ""}` };
    expect({ result, calls }).toEqual(
      expected === "next"
        ? { result: { value: { dso_party_id: "DSO::fromB" } }, calls: [scanA, scanB] }
        : { result: firstAnswer, calls: [scanA] },
    );
  });

  it("moves on when the first Scan does not answer within timeoutMs", async () => {
    const calls = stubScans({ [scanA]: { kind: "hang" }, [scanB]: ok(DSO_PARTY) });
    const client = new ScanClient({ baseUrls: [scanA, scanB], timeoutMs: 20 });
    await expect(client.getDsoPartyId()).resolves.toEqual(DSO_PARTY);
    expect(calls).toEqual([scanA, scanB]);
  });

  it("isScanUnavailable agrees with the table for errors that are not ScanApiError", () => {
    expect(isScanUnavailable(new TypeError("fetch failed"))).toBe(true);
    expect(isScanUnavailable(new DOMException("timed out", "TimeoutError"))).toBe(true);
    expect(isScanUnavailable(new ScanApiError(404, "Not Found", { kind: "empty" }))).toBe(false);
  });

  it("isScanUnavailable reads a ScanApiError of another package copy by its shape", () => {
    // An error object from a second installed copy fails `instanceof`.
    const copy = (status: number) => Object.assign(new Error(`HTTP ${status}`), { name: "ScanApiError", status, statusText: "x" });
    expect(isScanUnavailable(copy(404))).toBe(false);
    expect(isScanUnavailable(copy(400))).toBe(false);
    expect(isScanUnavailable(copy(403))).toBe(true);
    expect(isScanUnavailable(copy(503))).toBe(true);
    expect(isScanUnavailable({ status: 404 })).toBe(true);
  });
});

describe("a list of Scans: order and cooldown", () => {
  it("throws ScanUnavailableError with each attempt when no Scan answers", async () => {
    stubScans({ [scanA]: status(403), [scanB]: { kind: "network" }, [scanC]: status(503) });
    const client = new ScanClient({ baseUrls: [scanA, scanB, scanC] });
    const error = await client.getDsoPartyId().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ScanUnavailableError);
    const attempts = (error as ScanUnavailableError).attempts;
    expect(attempts.map(a => [a.baseUrl, a.kind])).toEqual([
      [scanA, "http"],
      [scanB, "transport"],
      [scanC, "http"],
    ]);
    expect((error as Error).message).toContain("HTTP 403");
  });

  it("asks the other Scans first while an unavailable Scan cools down, then asks it again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-07T12:00:00Z"));
    const behaviors: Record<string, Behavior> = { [scanA]: status(403), [scanB]: ok(DSO_PARTY) };
    const calls = stubScans(behaviors);
    const client = new ScanClient({ baseUrls: [scanA, scanB] });

    await client.getDsoPartyId();
    expect(calls).toEqual([scanA, scanB]);

    calls.length = 0;
    await client.getDsoPartyId();
    expect(calls).toEqual([scanB]);

    // Another client of the same Scans in the process skips scanA too.
    calls.length = 0;
    await new ScanClient({ baseUrls: [scanA, scanB] }).getDsoPartyId();
    expect(calls).toEqual([scanB]);

    // After the cooldown, the preferred Scan is first again.
    behaviors[scanA] = ok({ dso_party_id: "DSO::fromA" });
    vi.setSystemTime(Date.now() + DEFAULT_COOLDOWN_MS + 1);
    calls.length = 0;
    await expect(client.getDsoPartyId()).resolves.toEqual({ dso_party_id: "DSO::fromA" });
    expect(calls).toEqual([scanA]);
  });

  it("still asks a cooling Scan when every Scan is cooling, the earliest to recover first", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-07T12:00:00Z"));
    const behaviors: Record<string, Behavior> = { [scanA]: status(503), [scanB]: status(503) };
    const calls = stubScans(behaviors);
    const client = new ScanClient({ baseUrls: [scanA, scanB], cooldownMs: 1_000 });
    await expect(client.getDsoPartyId()).rejects.toBeInstanceOf(ScanUnavailableError);

    behaviors[scanA] = ok(DSO_PARTY);
    calls.length = 0;
    await expect(client.getDsoPartyId()).resolves.toEqual(DSO_PARTY);
    expect(calls, "scanA cooled first, so it recovers first").toEqual([scanA]);
  });

  it.each([0, -1, 0.5, 2_147_483_648, Number.NaN, Number.POSITIVE_INFINITY])("refuses timeoutMs %s", timeoutMs => {
    expect(() => new ScanClient({ baseUrls: [scanA], timeoutMs })).toThrow(RangeError);
    expect(() => new ScanClient({ baseUrl: scanA, timeoutMs })).toThrow(RangeError);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])("refuses cooldownMs %s", cooldownMs => {
    expect(() => new ScanClient({ baseUrls: [scanA], cooldownMs })).toThrow(RangeError);
  });

  it("with cooldownMs 0, asks the preferred Scan first on each request", async () => {
    const calls = stubScans({ [scanA]: status(403), [scanB]: ok(DSO_PARTY) });
    const client = new ScanClient({ baseUrls: [scanA, scanB], cooldownMs: 0 });
    await client.getDsoPartyId();
    await client.getDsoPartyId();
    expect(calls).toEqual([scanA, scanB, scanA, scanB]);
  });

  it("refuses an empty list that bypasses the type", () => {
    const baseUrls = [] as unknown as ScanBaseUrls;
    expect(() => new ScanClient({ baseUrls })).toThrow(RangeError);
  });

  it("removes duplicate base URLs and keeps the preferred Scan first", () => {
    const client = new ScanClient({ baseUrls: [scanA, scanB, scanA] });
    expect(client.baseUrls).toEqual([scanA, scanB]);
    expect(client.baseUrl).toBe(scanA);
  });

  it("sends the same method, path, query and body to the next Scan", async () => {
    const seen: Array<{ url: string; method: string | undefined; body: unknown }> = [];
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
      seen.push({ url: input, method: init?.method, body: init?.body });
      const status = input.startsWith(scanA) ? 429 : 200;
      return new Response(JSON.stringify({ transactions: [] }), {
        status,
        headers: { "content-type": "application/json" },
      });
    });
    const client = new ScanClient({ baseUrls: [scanA, scanB] });
    await client.getUpdates({ page_size: 10 });
    expect(seen.map(s => s.url)).toEqual([`${scanA}/v2/updates`, `${scanB}/v2/updates`]);
    expect(seen[0]!.method).toBe("POST");
    expect(seen[1]!.body).toBe(seen[0]!.body);
  });
});

describe("one Scan: the errors reach the caller as they are", () => {
  it("throws the Scan's ScanApiError for a 403", async () => {
    stubScans({ [scanA]: status(403) });
    const error = await new ScanClient({ baseUrl: scanA }).getDsoPartyId().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ScanApiError);
    expect((error as ScanApiError).status).toBe(403);
  });

  it("throws what fetch threw for a network error", async () => {
    stubScans({ [scanA]: { kind: "network" } });
    await expect(new ScanClient({ baseUrl: scanA }).getDsoPartyId()).rejects.toBeInstanceOf(TypeError);
  });

  it("a list of one Scan throws ScanUnavailableError", async () => {
    stubScans({ [scanA]: status(403) });
    await expect(new ScanClient({ baseUrls: [scanA] }).getDsoPartyId()).rejects.toBeInstanceOf(
      ScanUnavailableError,
    );
  });
});

describe("a list of Scans and the newer endpoints", () => {
  const DSO_V1 = { dso_party_id: "DSO::1220aa", voting_threshold: 3, sv_node_states: [] };

  it("uses the fallback of the Scans that answered 404 when the other Scans are unavailable", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: string) => {
      const url = new URL(input);
      calls.push(`${url.host.split(".")[0]}${url.pathname.slice("/api/scan".length)}`);
      if (input.startsWith(scanB)) return new Response("busy", { status: 503 });
      if (url.pathname.endsWith("/v1/dso")) return new Response("Not Found", { status: 404 });
      return new Response(JSON.stringify({ ...DSO_V1, sv_user: "sv", sv_party_id: "sv::1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const client = new ScanClient({ baseUrls: [scanA, scanB] });
    await expect(client.getDsoInfoV1()).resolves.toEqual(DSO_V1);
    calls.length = 0;
    // scanA is excluded for /v1/dso; scanB is unavailable; scanA still serves /v0/dso.
    await expect(client.getDsoInfoV1()).resolves.toEqual(DSO_V1);
    expect(calls).toEqual([`scan-b-${testCount}/v1/dso`, `scan-a-${testCount}/v0/dso`]);
  });

  it("records a 404 for the Scan that gave it, and asks the other Scans for the newer path", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: string) => {
      const url = new URL(input);
      calls.push(`${url.host.split(".")[0]}${url.pathname.slice("/api/scan".length)}`);
      const older = input.startsWith(scanA);
      if (url.pathname.endsWith("/v1/dso") && older) {
        return new Response("Not Found", { status: 404 });
      }
      return new Response(JSON.stringify({ ...DSO_V1, sv_user: "sv", sv_party_id: "sv::1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const client = new ScanClient({ baseUrls: [scanA, scanB] });
    await client.getDsoInfoV1();
    expect(calls).toEqual([`scan-a-${testCount}/v1/dso`, `scan-a-${testCount}/v0/dso`]);

    calls.length = 0;
    await client.getDsoInfoV1();
    expect(calls).toEqual([`scan-b-${testCount}/v1/dso`]);
  });
});
