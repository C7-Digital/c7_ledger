import {
  isArchiveAlreadyDoneError,
  isIndeterminateSubmitError,
  isTransientArchiveError,
} from "./submitError";
import { LedgerApiError } from "./error";
import type { JsCantonError } from "./types";

function payload(over: Partial<JsCantonError> = {}): JsCantonError {
  return {
    code: "SOME_CODE",
    cause: "something happened",
    context: {},
    errorCategory: 8,
    ...over,
  };
}

describe("submitError (directoryArchiveRetry parity)", () => {
  it("treats LOCKED and 503 as transient; bare 409 and already-done as not", () => {
    expect(
      isTransientArchiveError(
        new Error(
          "HTTP 409: Conflict — LOCAL_VERDICT_LOCKED_CONTRACTS: Rejected transaction is referring to locked contracts"
        )
      )
    ).toBe(true);
    expect(
      isTransientArchiveError(
        new Error(
          "HTTP 503: Service Unavailable — The server was not able to produce a timely response"
        )
      )
    ).toBe(true);
    expect(isTransientArchiveError(new LedgerApiError(503, "Service Unavailable"))).toBe(
      true
    );
    // Bare 409 without LOCKED is not retried (INACTIVE/DUPLICATE handled separately).
    expect(isTransientArchiveError(new LedgerApiError(409, "Conflict"))).toBe(false);
    expect(
      isTransientArchiveError(
        new Error("HTTP 409: Conflict — LOCAL_VERDICT_INACTIVE_CONTRACTS")
      )
    ).toBe(false);
    expect(isArchiveAlreadyDoneError(new Error("DUPLICATE_COMMAND: …"))).toBe(true);
    expect(isTransientArchiveError(new Error("DUPLICATE_COMMAND: …"))).toBe(false);
    expect(isTransientArchiveError(new Error("nope"))).toBe(false);
    expect(isTransientArchiveError(new LedgerApiError(400, "Bad Request"))).toBe(false);
  });

  it("treats Canton deadline (category 3) as indeterminate for command dedup", () => {
    const err = new LedgerApiError(504, "Gateway Timeout", {
      kind: "canton",
      error: payload({
        code: "DEADLINE_EXCEEDED",
        errorCategory: 3,
        cause: "Request state unknown",
      }),
    });
    expect(isIndeterminateSubmitError(err)).toBe(true);
    expect(isTransientArchiveError(err)).toBe(true);
  });

  it("does not treat PACKAGE_NAMES_NOT_FOUND (resourceMissing) as already done", () => {
    const err = new LedgerApiError(404, "Not Found", {
      kind: "canton",
      error: payload({
        code: "PACKAGE_NAMES_NOT_FOUND",
        errorCategory: 11,
        cause:
          "The following package names do not match upgradable packages uploaded on this participant: [c7-lei].",
      }),
    });
    expect(isArchiveAlreadyDoneError(err)).toBe(false);
    expect(isTransientArchiveError(err)).toBe(false);
  });
});
