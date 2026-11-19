import {
  retrySubmit,
  type RetryEvent,
  type RetrySubmitOptions,
  type SubmitAttempt,
  type SubmitOutcome,
} from "./retrySubmit";

// Compile-time checks: the tsgo typecheck (`pnpm typecheck`, and the build)
// fails this file when the retry API stops accepting a caller's code, or starts
// accepting code it must refuse. vitest itself does not typecheck. The
// functions below are never called.

const retry = { attempts: 3, initialDelayMs: 500, maxDelayMs: 5_000 };

describe("RetrySubmitOptions", () => {
  it("accepts sync, async and value-returning hooks", () => {
    const hooks = () => {
      const lines: string[] = [];
      const options: RetrySubmitOptions[] = [
        { commandId: "c", retry },
        { commandId: "c", retry, settle: { attempts: 8, delayMs: 5_000 } },
        { commandId: "c", retry, onRetry: () => {} },
        { commandId: "c", retry, onRetry: async () => {} },
        // Array.push returns a number.
        { commandId: "c", retry, onRetry: (e: RetryEvent) => lines.push(e.phase) },
        { commandId: "c", retry, retryAlso: () => false },
        { commandId: "c", retry, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) },
      ];
      // @ts-expect-error commandId is required
      const noCommandId: RetrySubmitOptions = { retry };
      // @ts-expect-error retry is required
      const noRetry: RetrySubmitOptions = { commandId: "c" };
      // @ts-expect-error retryAlso returns a boolean
      const asyncPredicate: RetrySubmitOptions = { commandId: "c", retry, retryAlso: async () => true };
      // @ts-expect-error the settle budget has a fixed delay, not a backoff
      const settleBackoff: RetrySubmitOptions = { commandId: "c", retry, settle: retry };
      return [options, noCommandId, noRetry, asyncPredicate, settleBackoff];
    };
    expect(typeof hooks).toBe("function");
  });
});

describe("retrySubmit", () => {
  it("returns the operation's value only in the submitted case", () => {
    const use = async () => {
      const op = async ({ commandId, attempt }: SubmitAttempt) => `${commandId}-${attempt}`;
      const outcome: SubmitOutcome<string> = await retrySubmit(op, { commandId: "c", retry });
      if (outcome.kind === "submitted") {
        const value: string = outcome.value;
        return value;
      }
      // @ts-expect-error an already applied command has no value
      return outcome.value;
    };
    expect(typeof use).toBe("function");
  });

  it("needs an operation that returns a promise", () => {
    const use = () => {
      // @ts-expect-error the operation must be async
      void retrySubmit(() => "value", { commandId: "c", retry });
    };
    expect(typeof use).toBe("function");
  });
});
