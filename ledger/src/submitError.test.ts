import {
  isArchiveAlreadyDoneError,
  isTransientArchiveError,
} from "./submitError";
import { LedgerApiError } from "./error";

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
});
