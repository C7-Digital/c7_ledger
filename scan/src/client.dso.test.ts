import { afterEach, beforeEach, vi } from "vitest";
import { ScanClient } from "./client.js";
import { ScanApiError } from "./error.js";

// The client remembers a 404 for each base URL in the process, so each test
// uses its own Scan.
let scanCount = 0;
let BASE = "";
beforeEach(() => {
  scanCount += 1;
  BASE = `https://scan-${scanCount}.example.com/api/scan`;
});

const DSO_V1 = {
  dso_party_id: "DSO::1220aa",
  voting_threshold: 3,
  latest_mining_round: { contract: {} },
  amulet_rules: { contract: {}, domain_id: "global-domain::1220bb" },
  dso_rules: { contract: {} },
  sv_node_states: [],
};

const SV_INFO = { sv_user: "sv1", sv_party_id: "sv1::1220cc" };

/** A Scan that answers each path from `routes`, and 404 for every other path. */
function stubScan(routes: Record<string, unknown>): string[] {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (input: string) => {
    const path = new URL(input).pathname.slice("/api/scan".length);
    calls.push(path);
    if (!(path in routes)) {
      return new Response("Not Found", { status: 404, statusText: "Not Found" });
    }
    return new Response(JSON.stringify(routes[path]), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getDsoInfoV1", () => {
  it("reads /v1/dso when Scan has it", async () => {
    const calls = stubScan({ "/v1/dso": DSO_V1 });
    const dso = await new ScanClient({ baseUrl: BASE }).getDsoInfoV1();
    expect(dso).toEqual(DSO_V1);
    expect(calls).toEqual(["/v1/dso"]);
  });

  it("reads /v0/dso without the SV fields when Scan has no /v1/dso", async () => {
    const calls = stubScan({ "/v0/dso": { ...DSO_V1, ...SV_INFO } });
    const dso = await new ScanClient({ baseUrl: BASE }).getDsoInfoV1();
    expect(dso).toEqual(DSO_V1);
    expect(calls).toEqual(["/v1/dso", "/v0/dso"]);
  });

  it("reads /v0/dso directly after one 404, also from a new client", async () => {
    const calls = stubScan({ "/v0/dso": { ...DSO_V1, ...SV_INFO } });
    await new ScanClient({ baseUrl: BASE }).getDsoInfoV1();
    expect(await new ScanClient({ baseUrl: BASE }).getDsoInfoV1()).toEqual(DSO_V1);
    expect(calls).toEqual(["/v1/dso", "/v0/dso", "/v0/dso"]);
  });

  it("keeps the 404 record for each Scan apart", async () => {
    const calls = stubScan({ "/v0/dso": { ...DSO_V1, ...SV_INFO } });
    await new ScanClient({ baseUrl: BASE }).getDsoInfoV1();
    const other = BASE.replace("scan-", "other-scan-");
    await new ScanClient({ baseUrl: other }).getDsoInfoV1();
    expect(calls).toEqual(["/v1/dso", "/v0/dso", "/v1/dso", "/v0/dso"]);
  });

  it("does not read /v0/dso when /v1/dso fails for another reason", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: string) => {
      calls.push(new URL(input).pathname.slice("/api/scan".length));
      return new Response("Bad Gateway", { status: 502, statusText: "Bad Gateway" });
    });
    const failure = new ScanClient({ baseUrl: BASE }).getDsoInfoV1();
    await expect(failure).rejects.toBeInstanceOf(ScanApiError);
    await expect(failure).rejects.toMatchObject({ status: 502 });
    expect(calls).toEqual(["/v1/dso"]);
  });
});

describe("getSvInfo", () => {
  it("reads /v0/sv-info when Scan has it", async () => {
    const calls = stubScan({ "/v0/sv-info": SV_INFO });
    expect(await new ScanClient({ baseUrl: BASE }).getSvInfo()).toEqual(SV_INFO);
    expect(calls).toEqual(["/v0/sv-info"]);
  });

  it("reads the SV fields of /v0/dso when Scan has no /v0/sv-info", async () => {
    const calls = stubScan({ "/v0/dso": { ...DSO_V1, ...SV_INFO } });
    expect(await new ScanClient({ baseUrl: BASE }).getSvInfo()).toEqual(SV_INFO);
    expect(calls).toEqual(["/v0/sv-info", "/v0/dso"]);
  });
});
