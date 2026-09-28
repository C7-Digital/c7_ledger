import { LedgerApiError, type LedgerErrorBody } from "./error";
import type { JsCantonError } from "./types";

function cantonBody(errorCategory: number): LedgerErrorBody {
  const error = {
    code: "TEST_CODE",
    cause: "test",
    errorCategory,
  } as JsCantonError;
  return { kind: "canton", error };
}

describe("LedgerApiError.isTransient", () => {
  it("is true for 408, 429, and any 5xx", () => {
    for (const status of [408, 429, 500, 502, 503, 504]) {
      expect(new LedgerApiError(status, "x").isTransient()).toBe(true);
    }
  });

  it("is false for a hard 4xx (400, 404, 409)", () => {
    for (const status of [400, 404, 409]) {
      expect(new LedgerApiError(status, "x").isTransient()).toBe(false);
    }
  });
});

describe("LedgerApiError.isIndeterminate", () => {
  it("is true for HTTP 503", () => {
    expect(new LedgerApiError(503, "Service Unavailable").isIndeterminate()).toBe(true);
  });

  it("is true for a Canton deadline (category 3) at any status", () => {
    expect(new LedgerApiError(409, "Conflict", cantonBody(3)).isIndeterminate()).toBe(true);
  });

  it("is false for a plain transient (429) with no Canton deadline", () => {
    expect(new LedgerApiError(429, "Too Many Requests").isIndeterminate()).toBe(false);
  });

  it("is false for contention (category 2) — that transaction did not commit", () => {
    expect(new LedgerApiError(409, "Conflict", cantonBody(2)).isIndeterminate()).toBe(false);
  });
});
