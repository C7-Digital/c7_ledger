import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, vi } from "vitest";
import YAML from "yaml";

import { ScanClient } from "./client.js";
import { SPLICE_VERSION } from "./generated/sdk-version.js";

const here = dirname(fileURLToPath(import.meta.url));
const BASE = "https://scan.example.com/api/scan";

// Paths of a later Splice line. The client reads them first and treats a 404
// as "not served yet" (see client.dso.test.ts).
const LATER_SPLICE_PATHS = new Set(["/v1/dso", "/v0/sv-info"]);

/** The Scan API paths that `ScanClient` calls, as `{param}` templates. */
function clientPaths(): string[] {
  const src = readFileSync(join(here, "client.ts"), "utf-8");
  const found = new Set<string>();
  for (const m of src.matchAll(/["`](\/v\d+\/[^"`?]*)["`?]/g)) {
    const path = m[1]!.replace(/\$\{[^}]+\}/g, "{param}").replace(/\/$/, "/{param}");
    found.add(path);
  }
  return [...found].sort();
}

/** The paths of the target Splice spec, with every parameter named `{param}`. */
function specPaths(): Set<string> {
  const spec = YAML.parse(
    readFileSync(join(here, "..", "specs", `scan_bundled_${SPLICE_VERSION}.yaml`), "utf-8"),
  ) as { paths: Record<string, unknown> };
  return new Set(Object.keys(spec.paths).map(p => p.replace(/\{[^}]+\}/g, "{param}")));
}

describe("ScanClient paths", () => {
  const spec = specPaths();

  it("finds the client's paths", () => {
    expect(clientPaths().length).toBeGreaterThan(30);
  });

  it.each(clientPaths().filter(p => !LATER_SPLICE_PATHS.has(p)))(
    `%s is in the Splice ${SPLICE_VERSION} Scan spec`,
    path => {
      expect(spec.has(path)).toBe(true);
    },
  );
});

describe("ScanClient reads ACS and holdings from the current endpoints", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function record(): Array<{ method: string; path: string }> {
    const calls: Array<{ method: string; path: string }> = [];
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
      calls.push({ method: init?.method ?? "GET", path: new URL(input).pathname });
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    return calls;
  }

  const scan = () => new ScanClient({ baseUrl: BASE });
  const at = {
    migration_id: 4,
    record_time: "2026-11-03T00:00:00Z",
    record_time_match: "exact" as const,
  };

  it.each<[string, string, (c: ScanClient) => Promise<unknown>]>([
    ["getAcsSnapshot", "/v2/state/acs", c => c.getAcsSnapshot({ ...at, page_size: 10 })],
    [
      "getHoldingsState",
      "/v2/holdings/state",
      c => c.getHoldingsState({ ...at, page_size: 10, owner_party_ids: ["alice::1220aa"] }),
    ],
    [
      "getHoldingsSummary",
      "/v1/holdings/summary",
      c => c.getHoldingsSummary({ ...at, owner_party_ids: ["alice::1220aa"] }),
    ],
  ])("%s POSTs to %s", async (_, path, call) => {
    const calls = record();
    await call(scan());
    expect(calls).toEqual([{ method: "POST", path: `/api/scan${path}` }]);
  });
});
