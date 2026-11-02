import { afterEach, vi } from "vitest";
import { ScanClient } from "./client.js";
import { ScanApiError } from "./error.js";

const BASE = "https://scan.example.com/api/scan";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getMigrationId", () => {
  it("reads the migration id from /v0/migrations/last", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: string) => {
      calls.push(new URL(input).pathname);
      return new Response(JSON.stringify({ migration_id: 4 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const { migration_id } = await new ScanClient({ baseUrl: BASE }).getMigrationId();
    expect(migration_id).toBe(4);
    expect(calls).toEqual(["/api/scan/v0/migrations/last"]);
  });

  it("throws a ScanApiError when Scan fails", async () => {
    vi.stubGlobal(
      "fetch",
      async () => new Response("Bad Gateway", { status: 502, statusText: "Bad Gateway" }),
    );
    await expect(new ScanClient({ baseUrl: BASE }).getMigrationId()).rejects.toBeInstanceOf(
      ScanApiError,
    );
  });
});
