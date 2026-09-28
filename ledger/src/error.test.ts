import { LedgerApiError, httpStatusOf } from "./error";

describe("httpStatusOf", () => {
  it("reads the status from a LedgerApiError instance", () => {
    expect(httpStatusOf(new LedgerApiError(503, "Service Unavailable"))).toBe(503);
  });

  it("reads a foreign-copy LedgerApiError-shaped value (structural, not instanceof)", () => {
    // A LedgerApiError from another copy of this package is not `instanceof`
    // ours; the structural probe (status + statusText) still recognizes it.
    const foreign = { name: "LedgerApiError", status: 429, statusText: "Too Many Requests" };
    expect(httpStatusOf(foreign)).toBe(429);
  });

  it("returns undefined for a bare object with a numeric status but no statusText", () => {
    expect(httpStatusOf({ status: 503 })).toBeUndefined();
  });

  it("returns undefined for non-error values", () => {
    expect(httpStatusOf(null)).toBeUndefined();
    expect(httpStatusOf(new Error("nope"))).toBeUndefined();
    expect(httpStatusOf("HTTP 503")).toBeUndefined();
  });
});
