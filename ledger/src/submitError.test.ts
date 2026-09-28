import {
  classifySubmitError,
  isIndeterminateSubmitTimeout,
  isLockedContractsError,
  isSubmitAlreadyApplied,
  isSubmitAlreadyGone,
  isTransientSubmitError,
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

describe("classifySubmitError", () => {
  it("classifies DUPLICATE_COMMAND as alreadyApplied", () => {
    const err = new LedgerApiError(409, "Conflict", {
      kind: "canton",
      error: payload({
        code: "DUPLICATE_COMMAND",
        errorCategory: 10,
        cause: "Duplicate command",
      }),
    });
    expect(classifySubmitError(err)).toBe("alreadyApplied");
    expect(isSubmitAlreadyApplied(err)).toBe(true);
    expect(isTransientSubmitError(err)).toBe(false);
  });

  it("classifies CONTRACT_NOT_FOUND / resourceMissing as alreadyGone", () => {
    const err = new LedgerApiError(404, "Not Found", {
      kind: "canton",
      error: payload({
        code: "CONTRACT_NOT_FOUND",
        errorCategory: 11,
        cause: "Contract could not be found",
      }),
    });
    expect(classifySubmitError(err)).toBe("alreadyGone");
    expect(isSubmitAlreadyGone(err)).toBe(true);
    expect(isTransientSubmitError(err)).toBe(false);
  });

  it("classifies INACTIVE_CONTRACTS message as alreadyGone (not transient)", () => {
    const err = new Error(
      "HTTP 409: Conflict — LOCAL_VERDICT_INACTIVE_CONTRACTS"
    );
    expect(classifySubmitError(err)).toBe("alreadyGone");
    expect(isTransientSubmitError(err)).toBe(false);
  });

  it("classifies HTTP 503 / timely response as indeterminate", () => {
    expect(classifySubmitError(new LedgerApiError(503, "Service Unavailable"))).toBe(
      "indeterminate"
    );
    expect(
      classifySubmitError(
        new Error(
          "HTTP 503: Service Unavailable — The server was not able to produce a timely response"
        )
      )
    ).toBe("indeterminate");
    expect(isIndeterminateSubmitTimeout(new LedgerApiError(503, "Service Unavailable"))).toBe(
      true
    );
    expect(isTransientSubmitError(new LedgerApiError(503, "Service Unavailable"))).toBe(
      true
    );
  });

  it("classifies LOCKED_CONTRACTS as transient", () => {
    const err = new LedgerApiError(409, "Conflict", {
      kind: "canton",
      error: payload({
        code: "LOCAL_VERDICT_LOCKED_CONTRACTS",
        errorCategory: 2,
        cause: "Rejected transaction is referring to locked contracts",
      }),
    });
    expect(classifySubmitError(err)).toBe("transient");
    expect(isLockedContractsError(err)).toBe(true);
    expect(isTransientSubmitError(err)).toBe(true);
  });

  it("classifies Canton retryable categories as transient", () => {
    const err = new LedgerApiError(503, "Service Unavailable", {
      kind: "canton",
      error: payload({
        code: "SERVER_IS_OVERLOADING",
        errorCategory: 1,
        cause: "Overloaded",
      }),
    });
    // 503 alone is indeterminate; with a Canton transient payload the HTTP
    // status still wins as indeterminate (outcome may be in flight). Prefer
    // that reading so callers wait + dedup rather than immediate backoff.
    expect(classifySubmitError(err)).toBe("indeterminate");

    const contention = new LedgerApiError(409, "Conflict", {
      kind: "canton",
      error: payload({
        code: "CONTRACT_STATE_CHANGED",
        errorCategory: 2,
        cause: "state changed",
      }),
    });
    expect(classifySubmitError(contention)).toBe("transient");
  });

  it("does not treat bare HTTP 409 as transient", () => {
    expect(classifySubmitError(new LedgerApiError(409, "Conflict"))).toBe("hard");
    expect(isTransientSubmitError(new LedgerApiError(409, "Conflict"))).toBe(false);
  });

  it("classifies 408 / 429 / other 5xx as transient", () => {
    expect(classifySubmitError(new LedgerApiError(408, "Request Timeout"))).toBe(
      "transient"
    );
    expect(classifySubmitError(new LedgerApiError(429, "Too Many Requests"))).toBe(
      "transient"
    );
    expect(classifySubmitError(new LedgerApiError(502, "Bad Gateway"))).toBe(
      "transient"
    );
    expect(classifySubmitError(new Error("HTTP 429: Too Many Requests"))).toBe(
      "transient"
    );
  });

  it("classifies unknown client errors as hard", () => {
    expect(classifySubmitError(new LedgerApiError(400, "Bad Request"))).toBe("hard");
    expect(classifySubmitError(new Error("nope"))).toBe("hard");
  });

  it("reads status structurally when instanceof would fail", () => {
    // Duplicated package copy in a pnpm tree: same shape, different constructor.
    const twin = Object.assign(new Error("HTTP 503: Service Unavailable"), {
      name: "LedgerApiError",
      status: 503,
      statusText: "Service Unavailable",
      body: { kind: "empty" as const },
    });
    expect(classifySubmitError(twin)).toBe("indeterminate");
  });
});
