import { LedgerApiError, type LedgerErrorBody } from "./error";
import { NoOpLogger, setLogger, ConsoleLogger } from "./logger";
import {
  retrySubmit,
  SubmitUnsettledError,
  type RetryEvent,
  type RetrySubmitOptions,
  type SubmitAttempt,
} from "./retrySubmit";
import type { JsCantonError } from "./types";

// A LedgerApiError with a structured Canton rejection: the shape in which a
// real submit rejection arrives.
function rejectedWith(status: number, code: string, errorCategory: number): LedgerApiError {
  const error = { code, cause: "test", errorCategory, context: {} } as JsCantonError;
  const body: LedgerErrorBody = { kind: "canton", error };
  return new LedgerApiError(status, "Rejected", body);
}

const TRAFFIC = (): LedgerApiError => rejectedWith(400, "SEQUENCER_NOT_ENOUGH_TRAFFIC_CREDIT", 9);
// The shape in which a participant gives a submit that the sequencer refused
// for lack of traffic: category 2 (retryable), a definite answer, and the inner
// code only in `context.sendError`.
const NO_TRAFFIC = (): LedgerApiError => {
  const error = {
    code: "SEQUENCER_REQUEST_FAILED",
    cause: "Failed to send command",
    errorCategory: 2,
    definiteAnswer: true,
    context: {
      sendError:
        "RequestRefused(\n  SendAsyncErrorGrpc(\n    GrpcRequestRefusedByServer: FAILED_PRECONDITION/" +
        "SEQUENCER_NOT_ENOUGH_TRAFFIC_CREDIT(9,ff6f9e7e): Submission was rejected because no traffic is " +
        "available: AboveTrafficLimit(...)\n  )\n)",
    },
  } as unknown as JsCantonError;
  return new LedgerApiError(409, "Conflict", { kind: "canton", error });
};
const SEND_FAILED = (): LedgerApiError => {
  const error = {
    code: "SEQUENCER_REQUEST_FAILED",
    cause: "Failed to send command",
    errorCategory: 2,
    definiteAnswer: true,
    context: { sendError: "RequestRefused(SendAsyncErrorGrpc(GrpcServiceUnavailable: UNAVAILABLE))" },
  } as unknown as JsCantonError;
  return new LedgerApiError(409, "Conflict", { kind: "canton", error });
};
const CONTENTION = (): LedgerApiError => rejectedWith(409, "LOCAL_VERDICT_LOCKED_CONTRACTS", 2);
const IN_FLIGHT = (): LedgerApiError => rejectedWith(409, "SUBMISSION_ALREADY_IN_FLIGHT", 2);
const DEADLINE = (): LedgerApiError => rejectedWith(504, "REQUEST_TIME_OUT", 3);
const DUPLICATE = (): LedgerApiError => rejectedWith(409, "DUPLICATE_COMMAND", 10);
const UNAVAILABLE = (): LedgerApiError => new LedgerApiError(503, "Service Unavailable");
const TOO_MANY = (): LedgerApiError => new LedgerApiError(429, "Too Many Requests");
const UNAUTHORIZED = (): LedgerApiError => new LedgerApiError(401, "Unauthorized");

/** An operation that fails with each error in turn, then returns "ok". */
function scripted(errors: Array<() => unknown>) {
  const calls: SubmitAttempt[] = [];
  const thrown: unknown[] = [];
  const op = async (attempt: SubmitAttempt) => {
    calls.push(attempt);
    const next = errors[calls.length - 1];
    if (next !== undefined) {
      const error = next();
      thrown.push(error);
      throw error;
    }
    return "ok";
  };
  return { op, calls, thrown };
}

function options(extra: Partial<RetrySubmitOptions> = {}) {
  const waits: number[] = [];
  const events: RetryEvent[] = [];
  const opts: RetrySubmitOptions = {
    commandId: "cmd-1",
    deduplicationMs: 600_000,
    retry: { attempts: 3, initialDelayMs: 100, maxDelayMs: 1_000 },
    settle: { attempts: 4, delayMs: 5_000 },
    onRetry: (e) => {
      events.push(e);
    },
    sleep: async (ms) => {
      waits.push(ms);
    },
    ...extra,
  };
  return { opts, waits, events };
}

beforeAll(() => setLogger(new NoOpLogger()));
afterAll(() => setLogger(new ConsoleLogger()));

// One row for each answer that a participant gives to a submit.
type ThrowRow = [name: string, error: () => unknown];
const THROWN_AT_ONCE: ThrowRow[] = [
  ["traffic credit (invalidState, category 9)", TRAFFIC],
  ["SEQUENCER_REQUEST_FAILED for lack of traffic (category 2)", NO_TRAFFIC],
  ["contract not found (resourceMissing, 11)", () => rejectedWith(404, "CONTRACT_NOT_FOUND", 11)],
  ["permission denied (403, no Canton payload)", () => new LedgerApiError(403, "Forbidden")],
  ["a plain Error", () => new Error("boom")],
  ["a thrown string", () => "boom"],
];

type OutcomeRow = [
  name: string,
  error: () => unknown,
  expected: "submitted" | "alreadyApplied",
  attempts: number,
];
const OUTCOMES: OutcomeRow[] = [
  ["contention (category 2)", CONTENTION, "submitted", 2],
  ["SEQUENCER_REQUEST_FAILED with another send error", SEND_FAILED, "submitted", 2],
  ["429 Too Many Requests", TOO_MANY, "submitted", 2],
  ["503 Service Unavailable (indeterminate)", UNAVAILABLE, "submitted", 2],
  ["deadline (category 3, indeterminate)", DEADLINE, "submitted", 2],
  ["SUBMISSION_ALREADY_IN_FLIGHT (indeterminate)", IN_FLIGHT, "submitted", 2],
  ["DUPLICATE_COMMAND", DUPLICATE, "alreadyApplied", 1],
];

describe("retrySubmit: each Canton answer to the first attempt", () => {
  it.each(THROWN_AT_ONCE)("%s → thrown after 1 attempt", async (_name, error) => {
    const { op, calls, thrown } = scripted([error]);
    const rejection = await retrySubmit(op, options().opts).then(
      () => "resolved",
      (e: unknown) => e,
    );
    expect(rejection).toBe(thrown[0]);
    expect(calls).toHaveLength(1);
  });

  it.each(OUTCOMES)("%s → %s after %i attempt(s)", async (_name, error, expected, attempts) => {
    const { op, calls } = scripted([error]);
    const result = await retrySubmit(op, options().opts);
    expect(result.kind).toBe(expected);
    expect(result.attempts).toBe(attempts);
    expect(calls).toHaveLength(attempts);
  });
});

describe("retrySubmit", () => {
  it("does not retry a definite traffic-credit rejection", async () => {
    const traffic = TRAFFIC();
    const { opts, waits, events } = options();
    const op = vi.fn(async () => {
      throw traffic;
    });
    await expect(retrySubmit(op, opts)).rejects.toBe(traffic);
    expect(op).toHaveBeenCalledTimes(1);
    expect(waits).toEqual([]);
    expect(events).toEqual([]);
  });

  it("does not retry a send that failed for lack of traffic, also when retryAlso accepts it", async () => {
    const noTraffic = NO_TRAFFIC();
    const { opts, waits } = options({ retryAlso: () => true });
    const op = vi.fn(async () => {
      throw noTraffic;
    });
    await expect(retrySubmit(op, opts)).rejects.toBe(noTraffic);
    expect(op).toHaveBeenCalledTimes(1);
    expect(waits).toEqual([]);
  });

  it("stops in the settle phase when the node runs out of traffic", async () => {
    const noTraffic = NO_TRAFFIC();
    const { op, calls } = scripted([UNAVAILABLE, IN_FLIGHT, () => noTraffic]);
    const { opts } = options();
    const error = await retrySubmit(op, opts).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SubmitUnsettledError);
    expect((error as SubmitUnsettledError).lastError).toBe(noTraffic);
    expect(calls).toHaveLength(3);
  });

  it("retries contention with exponential backoff up to the retry budget, then throws the last failure", async () => {
    const last = CONTENTION();
    const { op, calls } = scripted([CONTENTION, CONTENTION, () => last]);
    const { opts, waits } = options();
    await expect(retrySubmit(op, opts)).rejects.toBe(last);
    expect(calls).toHaveLength(3);
    expect(waits).toEqual([100, 200]);
  });

  it("caps the backoff at maxDelayMs", async () => {
    const { op } = scripted(Array.from({ length: 6 }, () => TOO_MANY));
    const { opts, waits } = options({
      retry: { attempts: 7, initialDelayMs: 100, maxDelayMs: 500 },
    });
    await retrySubmit(op, opts);
    expect(waits).toEqual([100, 200, 400, 500, 500, 500]);
  });

  it("gives the same commandId to every attempt", async () => {
    const { op, calls } = scripted([TOO_MANY, UNAVAILABLE, DEADLINE, IN_FLIGHT]);
    const { opts } = options();
    await retrySubmit(op, opts);
    expect(calls.map((c) => c.commandId)).toEqual(["cmd-1", "cmd-1", "cmd-1", "cmd-1", "cmd-1"]);
    expect(calls.map((c) => c.attempt)).toEqual([1, 2, 3, 4, 5]);
  });

  it("treats DUPLICATE_COMMAND after an indeterminate failure as already applied", async () => {
    const { op, calls } = scripted([UNAVAILABLE, DUPLICATE]);
    const { opts } = options();
    await expect(retrySubmit(op, opts)).resolves.toEqual({ kind: "alreadyApplied", attempts: 2 });
    expect(calls.map((c) => c.commandId)).toEqual(["cmd-1", "cmd-1"]);
  });

  it("keeps the outcome unsettled when the resubmit of a consuming exercise finds its contract gone", async () => {
    // The participant interprets before it deduplicates: when the 503 hid a
    // commit, the resubmit cannot find the contract that the commit archived.
    const gone = rejectedWith(404, "CONTRACT_NOT_FOUND", 11);
    const { op, calls } = scripted([UNAVAILABLE, () => gone]);
    const { opts } = options();
    const error = await retrySubmit(op, opts).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SubmitUnsettledError);
    expect((error as SubmitUnsettledError).lastError).toBe(gone);
    expect(calls.map((c) => c.commandId)).toEqual(["cmd-1", "cmd-1"]);
  });

  it("waits the settle delay after an indeterminate failure, with a new budget", async () => {
    // Two retries use 2 of the 3 retry attempts. The 503 starts the settle
    // phase, which has 4 attempts of its own.
    const { op, calls } = scripted([TOO_MANY, TOO_MANY, UNAVAILABLE, IN_FLIGHT, IN_FLIGHT]);
    const { opts, waits, events } = options();
    await expect(retrySubmit(op, opts)).resolves.toEqual({
      kind: "submitted",
      value: "ok",
      attempts: 6,
    });
    expect(calls).toHaveLength(6);
    expect(waits).toEqual([100, 200, 5_000, 5_000, 5_000]);
    expect(events.map((e) => e.phase)).toEqual(["retry", "retry", "settle", "settle", "settle"]);
    expect(events.map((e) => e.inFlight)).toEqual([false, false, false, true, true]);
    expect(events.map((e) => e.status)).toEqual([429, 429, 503, 409, 409]);
  });

  it("throws SubmitUnsettledError when the settle budget ends", async () => {
    const { op, calls } = scripted(Array.from({ length: 10 }, () => IN_FLIGHT));
    const { opts } = options();
    const error = await retrySubmit(op, opts).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SubmitUnsettledError);
    const unsettled = error as SubmitUnsettledError;
    expect(unsettled.commandId).toBe("cmd-1");
    expect(unsettled.attempts).toBe(4);
    expect(unsettled.lastError).toBeInstanceOf(LedgerApiError);
    expect(calls).toHaveLength(4);
  });

  it("stops at once on a definite rejection in the settle phase, and keeps the outcome unsettled", async () => {
    const traffic = TRAFFIC();
    const { op, calls } = scripted([UNAVAILABLE, () => traffic]);
    const { opts } = options();
    const error = await retrySubmit(op, opts).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SubmitUnsettledError);
    expect((error as SubmitUnsettledError).lastError).toBe(traffic);
    expect((error as SubmitUnsettledError).attempts).toBe(2);
    expect(calls).toHaveLength(2);
  });

  it("keeps the outcome unsettled when a 401 follows a 503, also when retryAlso accepts it", async () => {
    const unauthorized = new LedgerApiError(401, "Unauthorized");
    const { op, calls } = scripted([UNAVAILABLE, () => unauthorized]);
    const { opts } = options({ retryAlso: (e) => e === unauthorized });
    const error = await retrySubmit(op, opts).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SubmitUnsettledError);
    expect((error as SubmitUnsettledError).lastError).toBe(unauthorized);
    expect(calls).toHaveLength(2);
  });

  it("does not resubmit when the next attempt can start after the deduplication period", async () => {
    let clock = 0;
    const { op, calls } = scripted(Array.from({ length: 10 }, () => UNAVAILABLE));
    const { opts, waits } = options({
      deduplicationMs: 12_000,
      now: () => clock,
      sleep: async (ms) => {
        waits.push(ms);
        clock += ms;
      },
    });
    const error = await retrySubmit(op, opts).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SubmitUnsettledError);
    // Attempts start at 0, 5 000 and 10 000; an attempt at 15 000 is past 12 000.
    expect(calls).toHaveLength(3);
    expect(waits).toEqual([5_000, 5_000]);
  });

  it("counts the deduplication period from the attempt that went indeterminate", async () => {
    let clock = 0;
    const { op, calls } = scripted([CONTENTION, CONTENTION, UNAVAILABLE, UNAVAILABLE]);
    const { opts } = options({
      deduplicationMs: 10_001,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });
    // The contention waits (100, 200) come before the 503, so they do not count.
    await expect(retrySubmit(op, opts)).resolves.toMatchObject({ kind: "submitted", attempts: 5 });
    expect(calls).toHaveLength(5);
  });

  it("rejects an empty commandId before it runs the operation", async () => {
    for (const commandId of ["", "   "]) {
      const op = vi.fn(async () => "ok");
      await expect(retrySubmit(op, options({ commandId }).opts)).rejects.toBeInstanceOf(RangeError);
      expect(op).not.toHaveBeenCalled();
    }
  });

  it("gives a zero delay, not NaN, after more than 1024 failures with a zero backoff", async () => {
    const { op } = scripted(Array.from({ length: 1_030 }, () => TOO_MANY));
    const { opts, waits } = options({
      retry: { attempts: 1_030, initialDelayMs: 0, maxDelayMs: 0 },
    });
    await expect(retrySubmit(op, opts)).rejects.toBeInstanceOf(LedgerApiError);
    expect(waits).toHaveLength(1_029);
    expect(waits.every((ms) => ms === 0)).toBe(true);
  });

  it("without a settle budget, settles with the retry attempts and maxDelayMs", async () => {
    const { op } = scripted(Array.from({ length: 5 }, () => DEADLINE));
    const { opts, waits } = options({ settle: undefined });
    await expect(retrySubmit(op, opts)).rejects.toBeInstanceOf(SubmitUnsettledError);
    expect(waits).toEqual([1_000, 1_000]);
  });

  it("retries a failure that retryAlso accepts, only in the retry phase", async () => {
    const retryAlso = vi.fn((e: unknown) => e instanceof LedgerApiError && e.status === 401);
    const { op, calls } = scripted([UNAUTHORIZED, UNAUTHORIZED]);
    const { opts } = options({ retryAlso });
    await expect(retrySubmit(op, opts)).resolves.toMatchObject({ kind: "submitted", attempts: 3 });
    expect(calls).toHaveLength(3);

    const settling = scripted([UNAVAILABLE, UNAUTHORIZED]);
    const unauthorized = await retrySubmit(settling.op, options({ retryAlso }).opts).catch(
      (e: unknown) => e,
    );
    expect(unauthorized).toBeInstanceOf(SubmitUnsettledError);
    expect(((unauthorized as SubmitUnsettledError).lastError as LedgerApiError).status).toBe(401);
    expect(settling.calls).toHaveLength(2);
  });

  it("does not retry when retryAlso throws", async () => {
    const { op, calls } = scripted([UNAUTHORIZED]);
    const { opts } = options({
      retryAlso: () => {
        throw new Error("predicate failed");
      },
    });
    await expect(retrySubmit(op, opts)).rejects.toBeInstanceOf(LedgerApiError);
    expect(calls).toHaveLength(1);
  });

  it("continues when onRetry throws or rejects", async () => {
    let calls = 0;
    const { op } = scripted([TOO_MANY, TOO_MANY]);
    const { opts } = options({
      onRetry: () => {
        calls += 1;
        if (calls === 1) throw new Error("hook threw");
        return Promise.reject(new Error("hook rejected"));
      },
    });
    await expect(retrySubmit(op, opts)).resolves.toMatchObject({ kind: "submitted" });
    expect(calls).toBe(2);
  });

  it("retries an operation that throws synchronously", async () => {
    let calls = 0;
    const op = (): Promise<string> => {
      calls += 1;
      if (calls === 1) throw TOO_MANY();
      return Promise.resolve("ok");
    };
    const { opts } = options();
    await expect(retrySubmit(op, opts)).resolves.toMatchObject({ kind: "submitted", attempts: 2 });
  });

  it("with one attempt, runs the operation once", async () => {
    const { op, calls } = scripted([TOO_MANY]);
    const { opts } = options({ retry: { attempts: 1, initialDelayMs: 0, maxDelayMs: 0 } });
    await expect(retrySubmit(op, opts)).rejects.toBeInstanceOf(LedgerApiError);
    expect(calls).toHaveLength(1);
  });

  it.each([
    ["retry.attempts 0", { retry: { attempts: 0, initialDelayMs: 0, maxDelayMs: 0 } }],
    ["retry.attempts 1.5", { retry: { attempts: 1.5, initialDelayMs: 0, maxDelayMs: 0 } }],
    ["retry.attempts NaN", { retry: { attempts: Number.NaN, initialDelayMs: 0, maxDelayMs: 0 } }],
    ["retry.initialDelayMs -1", { retry: { attempts: 2, initialDelayMs: -1, maxDelayMs: 0 } }],
    ["retry.maxDelayMs Infinity", { retry: { attempts: 2, initialDelayMs: 0, maxDelayMs: Infinity } }],
    ["maxDelayMs below initialDelayMs", { retry: { attempts: 2, initialDelayMs: 10, maxDelayMs: 5 } }],
    ["settle.attempts -1", { settle: { attempts: -1, delayMs: 0 } }],
    ["settle.delayMs NaN", { settle: { attempts: 2, delayMs: Number.NaN } }],
    ["deduplicationMs 0", { deduplicationMs: 0 }],
    ["deduplicationMs Infinity", { deduplicationMs: Infinity }],
  ] as const)("rejects a budget that is not valid: %s", async (_name, extra) => {
    const op = vi.fn(async () => "ok");
    await expect(retrySubmit(op, options(extra).opts)).rejects.toBeInstanceOf(RangeError);
    expect(op).not.toHaveBeenCalled();
  });

  it("waits with setTimeout when no sleep is given", async () => {
    vi.useFakeTimers();
    try {
      const { op, calls } = scripted([TOO_MANY]);
      const pending = retrySubmit(op, {
        commandId: "cmd-1",
        deduplicationMs: 600_000,
        retry: { attempts: 2, initialDelayMs: 1_000, maxDelayMs: 1_000 },
      });
      await vi.advanceTimersByTimeAsync(999);
      expect(calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toMatchObject({ kind: "submitted", attempts: 2 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits the full delay when it is longer than one setTimeout", async () => {
    vi.useFakeTimers();
    try {
      const thirtyDays = 30 * 24 * 60 * 60 * 1000;
      const { op, calls } = scripted([TOO_MANY]);
      const pending = retrySubmit(op, {
        commandId: "cmd-1",
        deduplicationMs: 600_000,
        retry: { attempts: 2, initialDelayMs: thirtyDays, maxDelayMs: thirtyDays },
      });
      await vi.advanceTimersByTimeAsync(2_147_483_647);
      expect(calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(thirtyDays - 2_147_483_647 - 1);
      expect(calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toMatchObject({ kind: "submitted", attempts: 2 });
    } finally {
      vi.useRealTimers();
    }
  });
});
