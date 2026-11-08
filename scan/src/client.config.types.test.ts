// Compile-time checks of the ScanClient config. `pnpm typecheck` and the build
// compile this file; the runtime test only makes vitest load it.
import { ScanClient, type ScanClientConfig, type ScanListConfig } from "./client.js";

const ONE = "https://scan-1.example.com/api/scan";
const TWO = "https://scan-2.example.com/api/scan";

// One Scan, as before.
export const single: ScanClientConfig = { baseUrl: ONE };
export const singleWithTimeout: ScanClientConfig = { baseUrl: ONE, timeoutMs: 5_000 };

// A list: the preferred Scan first, then the fallbacks.
export const list: ScanClientConfig = { baseUrls: [ONE, TWO], cooldownMs: 10_000 };
const fallbacks: string[] = [TWO];
export const fromEnv: ScanListConfig = { baseUrls: [ONE, ...fallbacks] };

// @ts-expect-error a list names at least one Scan
export const empty: ScanClientConfig = { baseUrls: [] };

// @ts-expect-error a plain string[] can be empty: start it with the preferred Scan
export const unchecked: ScanClientConfig = { baseUrls: fallbacks };

// @ts-expect-error one Scan or a list, not both
export const both: ScanClientConfig = { baseUrl: ONE, baseUrls: [TWO] };

// @ts-expect-error the cooldown applies to a list only
export const cooldownOnOne: ScanClientConfig = { baseUrl: ONE, cooldownMs: 1 };

// @ts-expect-error a Scan is required
export const none: ScanClientConfig = {};

// The client keeps the list readonly, the preferred Scan first.
const client = new ScanClient(list);
export const preferred: string = client.baseUrls[0];
// @ts-expect-error the list is readonly
client.baseUrls.push(TWO);

describe("ScanClient config types", () => {
  it("compiles", () => {
    expect(preferred).toBe(ONE);
  });
});
