import { LedgerApiError, type LedgerErrorBody } from "./error";
import {
  isAlreadyApplied,
  isAlreadyArchived,
  isRetriableSubmit,
  isIndeterminateSubmit,
  isSubmissionInFlight,
  isConfirmedPermanentReject,
  isOutOfTraffic,
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

  it("is true for an in-flight submission (category 2, still retryable)", () => {
    expect(
      isRetriableSubmit(rejectedWith(409, "SUBMISSION_ALREADY_IN_FLIGHT", 2))
    ).toBe(true);
  });
});

describe("isSubmissionInFlight", () => {
  it("is true only for SUBMISSION_ALREADY_IN_FLIGHT (keyed on code, not category)", () => {
    expect(
      isSubmissionInFlight(rejectedWith(409, "SUBMISSION_ALREADY_IN_FLIGHT", 2))
    ).toBe(true);
  });

  it("is false for the other category-2 code that DID definitively not commit", () => {
    expect(
      isSubmissionInFlight(rejectedWith(409, "LOCAL_VERDICT_LOCKED_CONTRACTS", 2))
    ).toBe(false);
  });

  it("is false for a transport error with no Canton payload", () => {
    expect(isSubmissionInFlight(new LedgerApiError(503, "Service Unavailable"))).toBe(false);
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

  it("is true for an in-flight submission, though it shares category 2", () => {
    // SUBMISSION_ALREADY_IN_FLIGHT is category 2 like LOCKED_CONTRACTS above, but
    // its answer is not definite (definiteAnswer = false): the outcome is pending,
    // so it is indeterminate, not "did not commit". Keyed on code for that reason.
    expect(
      isIndeterminateSubmit(rejectedWith(409, "SUBMISSION_ALREADY_IN_FLIGHT", 2))
    ).toBe(true);
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

// The shape in which a participant gives a submit that the sequencer refused
// for lack of traffic: the wrapper code, category 2, a definite answer, and the
// inner sequencer error only as rendered text in `context.sendError`.
const OUT_OF_TRAFFIC_SEND_ERROR = [
  "RequestRefused(",
  "  SendAsyncErrorGrpc(",
  "    GrpcRequestRefusedByServer: FAILED_PRECONDITION/SEQUENCER_NOT_ENOUGH_TRAFFIC_CREDIT(9,ff6f9e7e): " +
    "Submission was rejected because no traffic is available: AboveTrafficLimit(member = PAR::node::1220aa, " +
    "trafficCost = 2048, trafficState = TrafficState(extraTrafficLimit = 5999400, extraTrafficConsumed = 5999400))",
  "  )",
  ")",
].join("\n");

function sequencerRequestFailed(sendError: unknown, status = 409): LedgerApiError {
  const error = {
    code: "SEQUENCER_REQUEST_FAILED",
    cause: "Failed to send command",
    errorCategory: 2,
    definiteAnswer: true,
    context: { sendError },
  } as unknown as JsCantonError;
  const body: LedgerErrorBody = { kind: "canton", error };
  return new LedgerApiError(status, "Conflict", body);
}

describe("isOutOfTraffic", () => {
  it("is true for SEQUENCER_REQUEST_FAILED whose sendError names SEQUENCER_NOT_ENOUGH_TRAFFIC_CREDIT", () => {
    expect(isOutOfTraffic(sequencerRequestFailed(OUT_OF_TRAFFIC_SEND_ERROR))).toBe(true);
  });

  it("is true for a top-level SEQUENCER_NOT_ENOUGH_TRAFFIC_CREDIT code", () => {
    expect(isOutOfTraffic(rejectedWith(400, "SEQUENCER_NOT_ENOUGH_TRAFFIC_CREDIT", 9))).toBe(true);
  });

  it("is true for the bare Canton payload, without the HTTP error around it", () => {
    const error = cantonOf(sequencerRequestFailed(OUT_OF_TRAFFIC_SEND_ERROR));
    expect(isOutOfTraffic(error)).toBe(true);
  });

  it.each([
    ["another send error", "RequestRefused(SendAsyncErrorGrpc(GrpcServiceUnavailable: UNAVAILABLE))"],
    ["a longer code that contains the id", "XSEQUENCER_NOT_ENOUGH_TRAFFIC_CREDIT_V2(9,0)"],
    ["no sendError", undefined],
    ["a sendError that is not a string", { code: "SEQUENCER_NOT_ENOUGH_TRAFFIC_CREDIT" }],
  ])("is false for SEQUENCER_REQUEST_FAILED with %s", (_name, sendError) => {
    expect(isOutOfTraffic(sequencerRequestFailed(sendError))).toBe(false);
  });

  it("is false when another code carries the traffic text", () => {
    const error = {
      code: "LOCAL_VERDICT_LOCKED_CONTRACTS",
      cause: "test",
      errorCategory: 2,
      context: { sendError: OUT_OF_TRAFFIC_SEND_ERROR },
    } as unknown as JsCantonError;
    expect(isOutOfTraffic(new LedgerApiError(409, "Conflict", { kind: "canton", error }))).toBe(false);
  });

  it("is false for a transport error and a plain Error", () => {
    expect(isOutOfTraffic(new LedgerApiError(503, "Service Unavailable"))).toBe(false);
    expect(isOutOfTraffic(new Error("SEQUENCER_NOT_ENOUGH_TRAFFIC_CREDIT"))).toBe(false);
  });
});

describe("a submit refused for lack of traffic", () => {
  it.each([409, 500, 503])("is not retriable, not indeterminate, and is a permanent reject (HTTP %i)", (status) => {
    const error = sequencerRequestFailed(OUT_OF_TRAFFIC_SEND_ERROR, status);
    expect(isRetriableSubmit(error)).toBe(false);
    expect(isIndeterminateSubmit(error)).toBe(false);
    expect(isConfirmedPermanentReject(error)).toBe(true);
  });

  it("stays retriable when SEQUENCER_REQUEST_FAILED has another send error", () => {
    const error = sequencerRequestFailed("RequestRefused(SendAsyncErrorGrpc(GrpcServiceUnavailable: UNAVAILABLE))");
    expect(isRetriableSubmit(error)).toBe(true);
    expect(isConfirmedPermanentReject(error)).toBe(false);
  });
});

function cantonOf(error: LedgerApiError): JsCantonError {
  if (error.body.kind !== "canton") throw new Error("test setup: not a Canton body");
  return error.body.error;
}
