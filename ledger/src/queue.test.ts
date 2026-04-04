import { jest } from "@jest/globals";
import { TransactionQueue } from "./queue";
import { InMemoryTransactionLog } from "./transaction-log";
import type { Ledger } from "./ledger";
import type { AnyCommand, Event } from "./types";

// Minimal mock Ledger that resolves submit() after a short delay
function mockLedger(options?: {
  submitDelay?: number;
  submitError?: Error;
  submitResult?: Event<object, unknown>[];
}): Ledger {
  const delay = options?.submitDelay ?? 10;
  return {
    submit: jest.fn(async () => {
      await new Promise((r) => setTimeout(r, delay));
      if (options?.submitError) throw options.submitError;
      return options?.submitResult ?? [];
    }) as any,
  } as unknown as Ledger;
}

describe("TransactionQueue", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it("creates a queue and reports depth", () => {
    const queue = new TransactionQueue({
      ledger: mockLedger(),
      budgetBytes: 200_000,
      windowMs: 1_200_000,
      mode: "time-spread",
    });
    expect(queue.depth).toBe(0);
  });

  it("enqueues and drains a single transaction", async () => {
    jest.useRealTimers();
    const ledger = mockLedger({ submitDelay: 0 });
    const log = new InMemoryTransactionLog();
    const queue = new TransactionQueue({
      ledger,
      budgetBytes: 200_000,
      windowMs: 1_200_000,
      mode: "time-spread",
      avgTxSizeBytes: 7000,
      spreadPeriodMs: 100, // short spread for fast test
      log,
    });

    const result = await queue.enqueue(async () => "done");
    expect(result).toBe("done");

    // Check log recorded the completion
    const all = await log.getAll();
    const completed = all.find((r) => r.state === "completed");
    expect(completed).toBeDefined();
  });

  it("respects priority ordering", async () => {
    const order: number[] = [];
    const ledger = {
      submit: jest.fn(async () => []),
    } as unknown as Ledger;

    const queue = new TransactionQueue({
      ledger,
      budgetBytes: 200_000,
      windowMs: 1_200_000,
      mode: "time-spread",
      avgTxSizeBytes: 7000,
    });

    // Enqueue low, then high priority — high should execute first
    queue.enqueue(async () => { order.push(1); return "low"; }, { priority: 0 });
    queue.enqueue(async () => { order.push(2); return "high"; }, { priority: 10 });

    // Drain both
    jest.advanceTimersByTime(100_000);
    await jest.advanceTimersByTimeAsync(200);
    jest.advanceTimersByTime(100_000);
    await jest.advanceTimersByTimeAsync(200);

    expect(order).toEqual([2, 1]);
  });

  it("rejects enqueue when closed", async () => {
    const queue = new TransactionQueue({
      ledger: mockLedger(),
      budgetBytes: 200_000,
      windowMs: 1_200_000,
      mode: "time-spread",
    });
    await queue.close();
    await expect(queue.enqueue(async () => "fail")).rejects.toThrow("closed");
  });

  it("pause and resume", async () => {
    const submitFn = jest.fn(async () => "ok");
    const queue = new TransactionQueue({
      ledger: mockLedger(),
      budgetBytes: 200_000,
      windowMs: 1_200_000,
      mode: "time-spread",
      avgTxSizeBytes: 7000,
    });

    queue.enqueue(submitFn);
    queue.pause();

    // Advance time — should not drain
    jest.advanceTimersByTime(100_000);
    await jest.advanceTimersByTimeAsync(100);
    expect(submitFn).not.toHaveBeenCalled();

    // Resume and drain
    queue.resume();
    jest.advanceTimersByTime(100_000);
    await jest.advanceTimersByTimeAsync(100);
    expect(submitFn).toHaveBeenCalled();
  });

  it("abort rejects all pending and returns records", () => {
    const queue = new TransactionQueue({
      ledger: mockLedger(),
      budgetBytes: 200_000,
      windowMs: 1_200_000,
      mode: "time-spread",
    });

    const p1 = queue.enqueue(async () => "a");
    const p2 = queue.enqueue(async () => "b");

    const aborted = queue.abort();
    expect(aborted).toHaveLength(2);
    expect(aborted[0].state).toBe("dead_lettered");

    // Promises should reject
    expect(p1).rejects.toThrow("aborted");
    expect(p2).rejects.toThrow("aborted");
  });

  it("retries transient errors with backoff", async () => {
    let attempts = 0;
    const failTwiceThenSucceed = jest.fn(async () => {
      attempts++;
      if (attempts <= 2) {
        const err: any = new Error("server error");
        err.status = 503;
        throw err;
      }
      return [];
    });
    const ledger = {
      submit: failTwiceThenSucceed,
    } as unknown as Ledger;

    const log = new InMemoryTransactionLog();
    const queue = new TransactionQueue({
      ledger,
      budgetBytes: 200_000,
      windowMs: 1_200_000,
      mode: "time-spread",
      avgTxSizeBytes: 7000,
      maxRetries: 3,
      baseRetryDelayMs: 100,
      log,
    });

    const resultPromise = queue.enqueue(
      async () => ledger.submit([] as AnyCommand[]),
    );

    // Drain: first attempt (fails)
    jest.advanceTimersByTime(100_000);
    await jest.advanceTimersByTimeAsync(100);

    // Retry 1 after backoff (100ms)
    jest.advanceTimersByTime(100);
    await jest.advanceTimersByTimeAsync(100);

    // Let the time-spread schedule kick in again
    jest.advanceTimersByTime(100_000);
    await jest.advanceTimersByTimeAsync(100);

    // Retry 2 after backoff (200ms)
    jest.advanceTimersByTime(200);
    await jest.advanceTimersByTimeAsync(100);

    // Let the time-spread schedule kick in again
    jest.advanceTimersByTime(100_000);
    await jest.advanceTimersByTimeAsync(100);

    const result = await resultPromise;
    expect(result).toEqual([]);
    expect(attempts).toBe(3);
  });

  it("dead-letters after max retries", async () => {
    jest.useRealTimers();
    const permanentFail = jest.fn(async () => {
      const err: any = new Error("server down");
      err.status = 500;
      throw err;
    });

    const deadLettered: string[] = [];
    const queue = new TransactionQueue({
      ledger: mockLedger(),
      budgetBytes: 200_000,
      windowMs: 1_200_000,
      mode: "time-spread",
      avgTxSizeBytes: 7000,
      spreadPeriodMs: 100,
      maxRetries: 1,
      baseRetryDelayMs: 50,
      onDeadLetter: (rec) => deadLettered.push(rec.id),
    });

    await expect(queue.enqueue(permanentFail)).rejects.toThrow("server down");
    expect(deadLettered).toHaveLength(1);
  });

  it("enqueueCommands delegates to ledger.submit", async () => {
    const ledger = mockLedger({ submitDelay: 0, submitResult: [] });
    const queue = new TransactionQueue({
      ledger,
      budgetBytes: 200_000,
      windowMs: 1_200_000,
      mode: "time-spread",
      avgTxSizeBytes: 7000,
    });

    const resultPromise = queue.enqueueCommands([] as AnyCommand[]);
    jest.advanceTimersByTime(100_000);
    await jest.advanceTimersByTimeAsync(100);

    const result = await resultPromise;
    expect(result).toEqual([]);
    expect(ledger.submit).toHaveBeenCalled();
  });

  it("getSnapshot returns current state", async () => {
    const queue = new TransactionQueue({
      ledger: mockLedger(),
      budgetBytes: 200_000,
      windowMs: 1_200_000,
      mode: "time-spread",
    });

    queue.enqueue(async () => "a");
    queue.enqueue(async () => "b");

    const snapshot = await queue.getSnapshot();
    expect(snapshot.depth).toBe(2);
    expect(snapshot.paused).toBe(false);
    expect(snapshot.budget.burstAmount).toBe(200_000);
    expect(snapshot.transactions).toHaveLength(2);
  });

  it("time-spread calculates delay based on budget and avg tx size", () => {
    // With 200KB budget, 7KB avg tx, 20 min window:
    // txns per window = 180_000 / 7000 ≈ 25.7
    // delay = 1_200_000 / 25.7 ≈ 46,667ms ≈ 46.7 seconds
    const queue = new TransactionQueue({
      ledger: mockLedger(),
      budgetBytes: 200_000,
      windowMs: 1_200_000,
      mode: "time-spread",
      avgTxSizeBytes: 7000,
      safetyMargin: 0.1,
    });

    // Enqueue one — the drain timer should be set
    queue.enqueue(async () => "a");

    // The transaction should NOT execute immediately
    jest.advanceTimersByTime(1000); // Only 1s
    // It should still be queued
    expect(queue.depth).toBe(1);
  });
});
