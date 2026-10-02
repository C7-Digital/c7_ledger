import { LedgerApiError, type LedgerErrorBody } from "./error";
import {
  isAlreadyApplied,
  isAlreadyArchived,
  isRetriableSubmit,
  isIndeterminateSubmit,
  isConfirmedPermanentReject,
} from "./submitClassify";
import type { JsCantonError } from "./types";

// Build a LedgerApiError carrying a structured Canton rejection — the shape a
// real submit reject arrives as, so the tests exercise the structured path
// (never a hand-crafted message string).
function canton(code: string, errorCategory: number): JsCantonError {
  // `context` is required by isCantonError (Canton always populates it).
  return { code, cause: "test", errorCategory, context: {} } as JsCantonError;
}
function rejectedWith(
  status: number,
  code: string,
  errorCategory: number
): LedgerApiError {
  const body: LedgerErrorBody = { kind: "canton", error: canton(code, errorCategory) };
  return new LedgerApiError(status, "Conflict", body);
}

describe("isAlreadyApplied", () => {
  it("is true only for DUPLICATE_COMMAND (the command already committed)", () => {
    expect(isAlreadyApplied(rejectedWith(409, "DUPLICATE_COMMAND", 10))).toBe(true);
  });

  it("is false for a contract-gone reject (that is not 'already applied')", () => {
    expect(isAlreadyApplied(rejectedWith(409, "CONTRACT_NOT_FOUND", 11))).toBe(false);
    expect(isAlreadyApplied(rejectedWith(409, "LOCAL_VERDICT_INACTIVE_CONTRACTS", 11))).toBe(false);
  });

  it("is false for a transport error with no Canton payload", () => {
    expect(isAlreadyApplied(new LedgerApiError(503, "Service Unavailable"))).toBe(false);
  });
});

describe("isAlreadyArchived", () => {
  it.each([
    ["DUPLICATE_COMMAND", 10],
    ["CONTRACT_NOT_FOUND", 11],
    ["LOCAL_VERDICT_INACTIVE_CONTRACTS", 11],
  ])("is true for %s (structured code)", (code, category) => {
    expect(isAlreadyArchived(rejectedWith(409, code, category as number))).toBe(true);
  });

  it("is false for UNSUPPORTED_CONTRACT_ID — same category 11, but a hard failure", () => {
    expect(isAlreadyArchived(rejectedWith(409, "UNSUPPORTED_CONTRACT_ID", 11))).toBe(false);
  });

  it("is false for a transport error with no Canton payload", () => {
    expect(isAlreadyArchived(new LedgerApiError(503, "Service Unavailable"))).toBe(false);
  });
});

describe("isRetriableSubmit", () => {
  it("is true for a transport transient (503)", () => {
    expect(isRetriableSubmit(new LedgerApiError(503, "Service Unavailable"))).toBe(true);
  });

  it("is true for Canton contention (LOCKED_CONTRACTS, category 2)", () => {
    expect(
      isRetriableSubmit(rejectedWith(409, "LOCAL_VERDICT_LOCKED_CONTRACTS", 2))
    ).toBe(true);
  });

  it("is false for a hard 400 and for an already-archived reject", () => {
    expect(isRetriableSubmit(new LedgerApiError(400, "Bad Request"))).toBe(false);
    // resourceMissing (11) is not retryable — the archive caller treats it as done.
    expect(isRetriableSubmit(rejectedWith(409, "CONTRACT_NOT_FOUND", 11))).toBe(false);
  });
});

describe("structural transport detection (survives duplicated package copies)", () => {
  // A LedgerApiError from another copy of this package is not `instanceof` ours,
  // but carries the same shape. The classifiers must still recognize it — this
  // fails with an `instanceof` check and passes with the structural probe.
  const foreign503 = {
    name: "LedgerApiError",
    status: 503,
    statusText: "Service Unavailable",
  };

  it("recognizes a foreign-copy 503 as retriable and indeterminate", () => {
    expect(isRetriableSubmit(foreign503)).toBe(true);
    expect(isIndeterminateSubmit(foreign503)).toBe(true);
  });

  it("ignores a plain object with a numeric status but no statusText", () => {
    expect(isRetriableSubmit({ status: 503 })).toBe(false);
  });
});

describe("isIndeterminateSubmit", () => {
  it("is true for HTTP 503", () => {
    expect(isIndeterminateSubmit(new LedgerApiError(503, "Service Unavailable"))).toBe(true);
  });

  it("is true for a Canton deadline (category 3) at any status", () => {
    expect(isIndeterminateSubmit(rejectedWith(409, "REQUEST_TIME_OUT", 3))).toBe(true);
  });

  it("is false for contention (category 2) — that transaction did not commit", () => {
    expect(
      isIndeterminateSubmit(rejectedWith(409, "LOCAL_VERDICT_LOCKED_CONTRACTS", 2))
    ).toBe(false);
  });
});

describe("isConfirmedPermanentReject", () => {
  it("is true for a structured non-retryable Canton reject (e.g. permission)", () => {
    // errorCategory 7 = permissionDenied — not retryable.
    expect(
      isConfirmedPermanentReject(rejectedWith(403, "NO_VIEW_ON_CONTRACT", 7))
    ).toBe(true);
  });

  it("is false for bare HTTP 4xx / plain Error — fail closed without Canton payload", () => {
    expect(isConfirmedPermanentReject(new LedgerApiError(400, "Bad Request"))).toBe(false);
    expect(isConfirmedPermanentReject(new Error("nope"))).toBe(false);
  });

  it("is false for retriable contention and for already-archived no-ops", () => {
    expect(
      isConfirmedPermanentReject(rejectedWith(409, "LOCAL_VERDICT_LOCKED_CONTRACTS", 2))
    ).toBe(false);
    expect(
      isConfirmedPermanentReject(rejectedWith(409, "CONTRACT_NOT_FOUND", 11))
    ).toBe(false);
    expect(
      isConfirmedPermanentReject(rejectedWith(409, "DUPLICATE_COMMAND", 10))
    ).toBe(false);
  });
});
