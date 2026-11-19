/**
 * Property tests for retrySubmit. fast-check generates the answers that an
 * operation can give (values, rejections, sync throws, each Canton category),
 * the budgets and the hooks that a caller outside this repository can give.
 * The test checks the invariants of the loop for each scenario.
 */
import fc from "fast-check";

import { LedgerApiError, type LedgerErrorBody } from "./error";
import { ConsoleLogger, NoOpLogger, setLogger } from "./logger";
import {
  retrySubmit,
  SubmitUnsettledError,
  type RetryEvent,
  type SubmitOutcome,
} from "./retrySubmit";
import {
  isAlreadyApplied,
  isIndeterminateSubmit,
  isOutOfTraffic,
  isRetriableSubmit,
} from "./submitClassify";
import type { JsCantonError } from "./types";

// The real setImmediate. Node reports an unhandled rejection only after the
// microtask queue is empty.
const realSetImmediate = globalThis.setImmediate;

/** What one attempt of the operation does. */
type Answer =
  | { kind: "value" }
  | { kind: "syncThrow" }
  | { kind: "plainReject" }
  | { kind: "http"; status: number }
  | { kind: "canton"; status: number; code: string; category: number }
  | { kind: "noTraffic"; status: number };

/** What one call to a hook does. */
type HookBehavior = "return" | "throw" | "reject";

const answer: fc.Arbitrary<Answer> = fc.oneof(
  { weight: 2, arbitrary: fc.constant({ kind: "value" as const }) },
  { weight: 1, arbitrary: fc.constant({ kind: "syncThrow" as const }) },
  { weight: 1, arbitrary: fc.constant({ kind: "plainReject" as const }) },
  {
    weight: 3,
    arbitrary: fc
      .constantFrom(400, 401, 403, 404, 408, 409, 429, 500, 502, 503, 504)
      .map((status) => ({ kind: "http" as const, status })),
  },
  {
    weight: 2,
    arbitrary: fc
      .constantFrom(409, 500, 503)
      .map((status) => ({ kind: "noTraffic" as const, status })),
  },
  {
    weight: 6,
    arbitrary: fc.record({
      kind: fc.constant("canton" as const),
      status: fc.constantFrom(400, 404, 409, 500, 503, 504),
      code: fc.constantFrom(
        "DUPLICATE_COMMAND",
        "SUBMISSION_ALREADY_IN_FLIGHT",
        "LOCAL_VERDICT_LOCKED_CONTRACTS",
        "SEQUENCER_NOT_ENOUGH_TRAFFIC_CREDIT",
        "CONTRACT_NOT_FOUND",
        "REQUEST_TIME_OUT",
        "SOME_FUTURE_CODE",
      ),
      // Every category Canton defines, and some it does not.
      category: fc.integer({ min: -1, max: 20 }),
    }),
  },
);

const hookBehavior: fc.Arbitrary<HookBehavior> = fc.constantFrom("return", "throw", "reject");

const delay = fc.oneof(
  fc.constant(0),
  fc.integer({ min: 0, max: 10_000 }),
  fc.constant(Number.MAX_SAFE_INTEGER),
);

const scenario = fc.record({
  answers: fc.array(answer, { maxLength: 40 }),
  retryAttempts: fc.integer({ min: 1, max: 12 }),
  initialDelayMs: delay,
  extraDelayMs: delay,
  settle: fc.option(fc.record({ attempts: fc.integer({ min: 1, max: 12 }), delayMs: delay }), {
    nil: undefined,
  }),
  retryAlso: fc.option(fc.constantFrom<HookBehavior | "401">("return", "throw", "401"), {
    nil: undefined,
  }),
  onRetry: fc.array(hookBehavior, { maxLength: 20 }),
});

function errorOf(a: Answer, attempt: number): unknown {
  switch (a.kind) {
    case "value":
    case "syncThrow":
      return null;
    case "plainReject":
      return new Error(`attempt ${attempt} rejected`);
    case "http":
      return new LedgerApiError(a.status, "status");
    case "noTraffic": {
      const error = {
        code: "SEQUENCER_REQUEST_FAILED",
        cause: "Failed to send command",
        errorCategory: 2,
        definiteAnswer: true,
        context: { sendError: "RequestRefused(GrpcRequestRefusedByServer: SEQUENCER_NOT_ENOUGH_TRAFFIC_CREDIT(9,0))" },
      };
      const body: LedgerErrorBody = { kind: "canton", error: error as unknown as JsCantonError };
      return new LedgerApiError(a.status, "rejected", body);
    }
    case "canton": {
      const error = { code: a.code, cause: "test", errorCategory: a.category, context: {} };
      const body: LedgerErrorBody = { kind: "canton", error: error as JsCantonError };
      return new LedgerApiError(a.status, "rejected", body);
    }
  }
}

describe("retrySubmit properties", () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };

  beforeAll(() => {
    setLogger(new NoOpLogger());
    process.on("unhandledRejection", onUnhandled);
  });

  afterAll(() => {
    process.off("unhandledRejection", onUnhandled);
    setLogger(new ConsoleLogger());
  });

  it("keeps its invariants for any answers, budgets and hooks", async () => {
    await fc.assert(
      fc.asyncProperty(scenario, async (s) => {
        unhandled.length = 0;
        const commandIds: string[] = [];
        const attemptNumbers: number[] = [];
        const errors: unknown[] = [];
        const waits: number[] = [];
        const events: RetryEvent[] = [];
        let hookCalls = 0;

        const op = (attempt: { commandId: string; attempt: number }): Promise<string> => {
          commandIds.push(attempt.commandId);
          attemptNumbers.push(attempt.attempt);
          const a: Answer = s.answers[attempt.attempt - 1] ?? { kind: "value" };
          if (a.kind === "value") return Promise.resolve(`value-${attempt.attempt}`);
          if (a.kind === "syncThrow") {
            const error = new Error(`attempt ${attempt.attempt} threw`);
            errors.push(error);
            throw error;
          }
          const error = errorOf(a, attempt.attempt);
          errors.push(error);
          return Promise.reject(error);
        };

        const retryAlso =
          s.retryAlso === undefined
            ? undefined
            : (e: unknown) => {
                if (s.retryAlso === "throw") throw new Error("predicate threw");
                return s.retryAlso === "401" && e instanceof LedgerApiError && e.status === 401;
              };

        const result: { ok: SubmitOutcome<string> } | { error: unknown } = await retrySubmit(op, {
          commandId: "cmd",
          retry: {
            attempts: s.retryAttempts,
            initialDelayMs: s.initialDelayMs,
            maxDelayMs: Math.min(s.initialDelayMs + s.extraDelayMs, Number.MAX_SAFE_INTEGER),
          },
          settle: s.settle,
          retryAlso,
          onRetry: (event) => {
            events.push(event);
            const behavior = s.onRetry[hookCalls] ?? "return";
            hookCalls += 1;
            if (behavior === "throw") throw new Error("hook threw");
            if (behavior === "reject") return Promise.reject(new Error("hook rejected"));
            return undefined;
          },
          sleep: async (ms) => {
            waits.push(ms);
          },
        }).then(
          (ok) => ({ ok }),
          (error: unknown) => ({ error }),
        );

        await new Promise<void>((resolve) => realSetImmediate(resolve));

        const calls = commandIds.length;
        const settleAttempts = s.settle?.attempts ?? s.retryAttempts;

        // Every attempt gets the same command id, and the attempts count from 1.
        expect(commandIds.every((id) => id === "cmd")).toBe(true);
        expect(attemptNumbers).toEqual(Array.from({ length: calls }, (_, i) => i + 1));

        // The loop never runs more attempts than the two budgets allow.
        expect(calls).toBeGreaterThanOrEqual(1);
        expect(calls).toBeLessThanOrEqual(s.retryAttempts + settleAttempts);

        // There is one wait and one event between two attempts, and no wait
        // after the last attempt.
        expect(waits).toHaveLength(calls - 1);
        expect(events).toHaveLength(calls - 1);
        expect(events.map((e) => e.delayMs)).toEqual(waits);
        expect(waits.every((ms) => Number.isFinite(ms) && ms >= 0)).toBe(true);

        // Each wait follows a failure that the loop can retry, and the event
        // carries that failure.
        events.forEach((e, i) => {
          expect(e.attempt).toBe(i + 1);
          expect(e.error).toBe(errors[i]);
          expect(isAlreadyApplied(e.error)).toBe(false);
          // The loop never waits to retry a node with no traffic.
          expect(isOutOfTraffic(e.error)).toBe(false);
        });

        // The checks below depend on how the loop ended, so they collect the
        // broken invariants, and one expect checks that there are none.
        const broken: string[] = [];
        const last = errors[calls - 1];

        // Once the loop settles, it stays in the settle phase, and an
        // indeterminate failure started it.
        const firstSettle = events.findIndex((e) => e.phase === "settle");
        const settled = firstSettle >= 0;
        if (settled && !events.slice(firstSettle).every((e) => e.phase === "settle")) {
          broken.push("left the settle phase");
        }
        if (settled && !isIndeterminateSubmit(events[firstSettle]?.error)) {
          broken.push("settled without an indeterminate failure");
        }

        const lastAnswer: Answer = s.answers[calls - 1] ?? { kind: "value" };
        if ("ok" in result) {
          if (result.ok.attempts !== calls) broken.push("wrong attempt count");
          if (result.ok.kind === "submitted") {
            if (lastAnswer.kind !== "value") broken.push("submitted after a failure");
            if (result.ok.value !== `value-${calls}`) broken.push("wrong value");
          } else if (!isAlreadyApplied(last)) {
            broken.push("alreadyApplied without DUPLICATE_COMMAND");
          }
        } else if (result.error instanceof SubmitUnsettledError) {
          if (!settled && !isIndeterminateSubmit(last)) broken.push("unsettled without settling");
          if (result.error.lastError !== last) broken.push("unsettled hides the last failure");
          if (result.error.attempts !== calls) broken.push("unsettled has a wrong count");
        } else {
          // Any other rejection is the operation's own last failure.
          if (result.error !== last) broken.push("rejected with another value");
          // A failure that the loop retries ends it only when the retry
          // budget is used up, before any settle phase.
          const callerRetries =
            s.retryAlso === "401" &&
            !settled &&
            !isOutOfTraffic(last) &&
            last instanceof LedgerApiError &&
            last.status === 401;
          const retried = isRetriableSubmit(last) || isIndeterminateSubmit(last) || callerRetries;
          if (retried && (calls !== s.retryAttempts || settled)) {
            broken.push("stopped on a retriable failure with budget left");
          }
        }
        expect(broken).toEqual([]);

        // A hook that throws or rejects never reaches the caller.
        expect(unhandled).toEqual([]);
      }),
      { numRuns: 500 },
    );
  });
});
