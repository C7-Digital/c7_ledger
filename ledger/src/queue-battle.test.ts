/**
 * Battle tests for TransactionQueue.
 *
 * These tests exercise concurrency, shutdown semantics, retry edge cases,
 * budget integration, log ordering, and stress scenarios that go beyond
 * the basic unit tests in queue.test.ts.
 */
import { jest } from "@jest/globals";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TransactionQueue } from "./queue";
import {
  InMemoryTransactionLog,
  JsonlTransactionLog,
  type TransactionRecord,
  type TransactionState,
} from "./transaction-log";
import type { Ledger } from "./ledger";
import type { AnyCommand } from "./types";

// ── Helpers ─────────────────────────────────────────────────────

function fastQueue(
  ledgerOrFn: Ledger | (() => Promise<any>),
  overrides?: Partial<ConstructorParameters<typeof TransactionQueue>[0]>,
) {
  const ledger =
    typeof ledgerOrFn === "function"
      ? ({ submit: ledgerOrFn } as unknown as Ledger)
      : ledgerOrFn;
  return new TransactionQueue({
    ledger,
    budgetBytes: 200_000,
    windowMs: 1_200_000,
    mode: "time-spread",
    avgTxSizeBytes: 7000,
    spreadPeriodMs: 50, // fast for tests
    baseRetryDelayMs: 20,
    ...overrides,
  });
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function transientError(msg = "503") {
  const err: any = new Error(msg);
  err.status = 503;
  return err;
}

function nonTransientError(msg = "400 bad request") {
  const err: any = new Error(msg);
  err.status = 400;
  return err;
}

// ── Tests ───────────────────────────────────────────────────────

describe("TransactionQueue — shutdown semantics", () => {
  it("close() waits for in-flight submission to complete", async () => {
    let submitResolved = false;
    const slowLedger = {
      submit: jest.fn(async () => {
        await delay(200);
        submitResolved = true;
        return [];
      }),
    } as unknown as Ledger;

    const queue = fastQueue(slowLedger);

    // Enqueue and immediately close
    const txPromise = queue.enqueue(async () => slowLedger.submit([] as any));
    // Give the drain scheduler a tick to start
    await delay(100);
    const closePromise = queue.close();

    // close should NOT have resolved yet — tx is still in flight
    let closeDone = false;
    closePromise.then(() => { closeDone = true; });
    await delay(50);
    expect(closeDone).toBe(false);

    // Wait for everything
    await closePromise;
    expect(submitResolved).toBe(true);
    await txPromise;
  });

  it("close() resolves immediately when queue is empty and nothing in-flight", async () => {
    const queue = fastQueue({ submit: jest.fn() } as any);
    // Should resolve immediately without hanging
    await queue.close();
  });

  it("close() waits for multiple in-flight items to complete sequentially", async () => {
    const order: number[] = [];
    const ledger = {
      submit: jest.fn(async () => []),
    } as unknown as Ledger;

    const queue = fastQueue(ledger);
    const p1 = queue.enqueue(async () => { order.push(1); return ledger.submit([] as any); });
    const p2 = queue.enqueue(async () => { order.push(2); return ledger.submit([] as any); });
    const p3 = queue.enqueue(async () => { order.push(3); return ledger.submit([] as any); });

    await queue.close();
    await Promise.all([p1, p2, p3]);
    expect(order).toEqual([1, 2, 3]);
  });
});

describe("TransactionQueue — abort semantics", () => {
  it("abort cancels pending retry timers", async () => {
    let attempts = 0;
    const alwaysFail = jest.fn(async () => {
      attempts++;
      throw transientError();
    });

    const queue = fastQueue(alwaysFail, { maxRetries: 5 });

    // Catch the rejection so it doesn't become unhandled
    const txPromise = queue.enqueue(async () => alwaysFail()).catch(() => {});
    // Wait for first attempt + entry into retry backoff
    await delay(150);

    queue.abort();
    // Wait to make sure no more attempts happen after abort
    const attemptsAtAbort = attempts;
    await delay(300);
    expect(attempts).toBe(attemptsAtAbort);

    await txPromise;
  });

  it("abort during retry backoff does not re-enqueue the entry", async () => {
    let attempts = 0;
    const failOnce = jest.fn(async () => {
      attempts++;
      if (attempts === 1) throw transientError();
      return "ok";
    });

    const queue = fastQueue(failOnce, {
      maxRetries: 3,
      baseRetryDelayMs: 200, // long enough to abort during
    });

    const txPromise = queue.enqueue(async () => failOnce()).catch(() => {});
    // Wait for first attempt to fail and enter backoff
    await delay(150);
    expect(attempts).toBe(1);

    // Abort during the backoff window
    const aborted = queue.abort();
    // The retrying entry should be in the aborted list
    expect(aborted.length).toBeGreaterThanOrEqual(1);

    // Wait past the backoff — should NOT retry
    await delay(500);
    expect(attempts).toBe(1); // no second attempt

    await txPromise;
  });

  it("enqueue after abort rejects", async () => {
    const queue = fastQueue({ submit: jest.fn() } as any);
    queue.abort();
    await expect(queue.enqueue(async () => "x")).rejects.toThrow("closed");
  });
});

describe("TransactionQueue — retry behavior", () => {
  it("does not retry non-transient errors (4xx)", async () => {
    let attempts = 0;
    const fail400 = jest.fn(async () => {
      attempts++;
      throw nonTransientError();
    });

    const queue = fastQueue(fail400, { maxRetries: 5 });
    await expect(queue.enqueue(async () => fail400())).rejects.toThrow("400");
    expect(attempts).toBe(1); // no retries
  });

  it("retries network errors (ECONNREFUSED)", async () => {
    let attempts = 0;
    const failThenSucceed = jest.fn(async () => {
      attempts++;
      if (attempts === 1) {
        const err: any = new Error("connect failed");
        err.code = "ECONNREFUSED";
        throw err;
      }
      return "ok";
    });

    const queue = fastQueue(failThenSucceed, { maxRetries: 3 });
    const result = await queue.enqueue(async () => failThenSucceed());
    expect(result).toBe("ok");
    expect(attempts).toBe(2);
  });

  it("retries 429 rate limit errors", async () => {
    let attempts = 0;
    const failThenSucceed = jest.fn(async () => {
      attempts++;
      if (attempts === 1) {
        const err: any = new Error("rate limited");
        err.status = 429;
        throw err;
      }
      return "ok";
    });

    const queue = fastQueue(failThenSucceed, { maxRetries: 3 });
    const result = await queue.enqueue(async () => failThenSucceed());
    expect(result).toBe("ok");
    expect(attempts).toBe(2);
  });

  it("tracks retry count in transaction record", async () => {
    let attempts = 0;
    const failTwice = jest.fn(async () => {
      attempts++;
      if (attempts <= 2) throw transientError();
      return "ok";
    });

    const log = new InMemoryTransactionLog();
    const queue = fastQueue(failTwice, { maxRetries: 3, log });
    await queue.enqueue(async () => failTwice());

    const all = await log.getAll();
    const completed = all.find((r) => r.state === "completed");
    expect(completed).toBeDefined();
    expect(completed!.retryCount).toBe(2);
  });

  it("budget is reclaimed on transient failure", async () => {
    let attempts = 0;
    const failOnce = jest.fn(async () => {
      attempts++;
      if (attempts === 1) throw transientError();
      return "ok";
    });

    const queue = fastQueue(failOnce, {
      maxRetries: 3,
      avgTxSizeBytes: 50_000, // large tx
    });

    const budgetBefore = queue.bytesRemaining;
    await queue.enqueue(async () => failOnce());
    // Budget should reflect one successful submission, not two
    // (failed attempt's budget was reclaimed)
    const budgetAfter = queue.bytesRemaining;
    expect(budgetBefore - budgetAfter).toBeCloseTo(50_000, -3);
  });
});

describe("TransactionQueue — priority ordering", () => {
  it("processes higher priority first with multiple levels", async () => {
    const order: string[] = [];
    const ledger = { submit: jest.fn(async () => []) } as unknown as Ledger;
    const queue = fastQueue(ledger);

    const promises = [
      queue.enqueue(async () => { order.push("low"); }, { priority: 0 }),
      queue.enqueue(async () => { order.push("med"); }, { priority: 5 }),
      queue.enqueue(async () => { order.push("high"); }, { priority: 10 }),
      queue.enqueue(async () => { order.push("urgent"); }, { priority: 100 }),
    ];

    await Promise.all(promises);
    expect(order).toEqual(["urgent", "high", "med", "low"]);
  });

  it("preserves FIFO within the same priority", async () => {
    const order: number[] = [];
    const ledger = { submit: jest.fn(async () => []) } as unknown as Ledger;
    const queue = fastQueue(ledger);

    const promises = [];
    for (let i = 0; i < 5; i++) {
      const idx = i;
      promises.push(queue.enqueue(async () => { order.push(idx); }, { priority: 0 }));
    }

    await Promise.all(promises);
    expect(order).toEqual([0, 1, 2, 3, 4]);
  });

  it("negative priorities are lower than zero", async () => {
    const order: string[] = [];
    const ledger = { submit: jest.fn(async () => []) } as unknown as Ledger;
    const queue = fastQueue(ledger);

    const promises = [
      queue.enqueue(async () => { order.push("negative"); }, { priority: -10 }),
      queue.enqueue(async () => { order.push("zero"); }, { priority: 0 }),
    ];

    await Promise.all(promises);
    expect(order).toEqual(["zero", "negative"]);
  });
});

describe("TransactionQueue — transaction log lifecycle", () => {
  it("records full state machine transitions", async () => {
    const states: Array<{ id: string; state: TransactionState }> = [];
    const log: InMemoryTransactionLog & { record: jest.Mock } = new InMemoryTransactionLog() as any;
    const origRecord = log.record.bind(log);
    log.record = jest.fn(async (entry: TransactionRecord) => {
      states.push({ id: entry.id, state: entry.state });
      return origRecord(entry);
    }) as any;

    const queue = fastQueue({ submit: jest.fn(async () => []) } as any, { log });
    await queue.enqueue(async () => []);

    // Should see: queued → submitting → completed
    const txStates = states.map((s) => s.state);
    expect(txStates).toEqual(["queued", "submitting", "completed"]);
  });

  it("records retry transitions in log", async () => {
    let attempts = 0;
    const failOnce = jest.fn(async () => {
      attempts++;
      if (attempts === 1) throw transientError();
      return "ok";
    });

    const log = new InMemoryTransactionLog();
    const queue = fastQueue(failOnce, { maxRetries: 3, log });
    await queue.enqueue(async () => failOnce());

    const all = await log.getAll();
    // The record should exist and show retryCount = 1
    expect(all).toHaveLength(1);
    expect(all[0]!.retryCount).toBe(1);
    expect(all[0]!.state).toBe("completed");
  });

  it("dead-lettered transactions are recorded with error", async () => {
    const alwaysFail = jest.fn(async () => {
      throw transientError("permanent 503");
    });

    const log = new InMemoryTransactionLog();
    const queue = fastQueue(alwaysFail, { maxRetries: 0, log });

    await expect(queue.enqueue(async () => alwaysFail())).rejects.toThrow();

    const all = await log.getAll();
    expect(all).toHaveLength(1);
    expect(all[0]!.state).toBe("dead_lettered");
    expect(all[0]!.error).toContain("permanent 503");
  });

  it("tags are preserved through lifecycle", async () => {
    const log = new InMemoryTransactionLog();
    const queue = fastQueue({ submit: jest.fn(async () => []) } as any, { log });

    await queue.enqueue(async () => [], { tag: "verify:example.com" });

    const all = await log.getAll();
    expect(all[0]!.tag).toBe("verify:example.com");
  });
});

describe("TransactionQueue — JSONL log ordering and recovery", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "txq-battle-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("JSONL entries are ordered: queued always before submitting", async () => {
    const filePath = join(tmpDir, "order.jsonl");
    const log = new JsonlTransactionLog(filePath);
    const queue = fastQueue({ submit: jest.fn(async () => []) } as any, { log });

    await queue.enqueue(async () => []);

    const content = await readFile(filePath, "utf-8");
    const lines = content.trim().split("\n").map((l) => JSON.parse(l));

    // Find lines for the same tx id
    const txId = lines[0].id;
    const txLines = lines.filter((l: any) => l.id === txId);

    const stateOrder = txLines.map((l: any) => l.state);
    expect(stateOrder).toEqual(["queued", "submitting", "completed"]);
  });

  it("JSONL recovery: last entry per id wins", async () => {
    const filePath = join(tmpDir, "recovery.jsonl");
    const log = new JsonlTransactionLog(filePath);
    const queue = fastQueue({ submit: jest.fn(async () => []) } as any, { log });

    // Process 3 transactions
    await Promise.all([
      queue.enqueue(async () => []),
      queue.enqueue(async () => []),
      queue.enqueue(async () => []),
    ]);

    // Fresh log instance simulating restart
    const recoveredLog = new JsonlTransactionLog(filePath);
    const all = await recoveredLog.getAll();

    // All 3 should show as completed (the last entry per ID)
    expect(all).toHaveLength(3);
    for (const record of all) {
      expect(record.state).toBe("completed");
    }
  });

  it("JSONL recovery finds stuck transactions after simulated crash", async () => {
    const filePath = join(tmpDir, "crash.jsonl");

    // Manually write entries simulating a crash mid-submission
    const { appendFile } = await import("node:fs/promises");
    const now = new Date().toISOString();
    const entries: TransactionRecord[] = [
      { id: "tx-1", commandId: "cmd-1", state: "completed", retryCount: 0, enqueuedAt: now, updatedAt: now, priority: 0 },
      { id: "tx-2", commandId: "cmd-2", state: "queued", retryCount: 0, enqueuedAt: now, updatedAt: now, priority: 0 },
      { id: "tx-2", commandId: "cmd-2", state: "submitting", retryCount: 0, enqueuedAt: now, updatedAt: now, priority: 0 },
      // tx-2 crashed during submission — no "completed" entry
      { id: "tx-3", commandId: "cmd-3", state: "queued", retryCount: 0, enqueuedAt: now, updatedAt: now, priority: 0 },
      // tx-3 never even started
    ];
    for (const entry of entries) {
      await appendFile(filePath, JSON.stringify(entry) + "\n");
    }

    const recoveredLog = new JsonlTransactionLog(filePath);
    const submitting = await recoveredLog.getByState("submitting");
    const queued = await recoveredLog.getByState("queued");
    const completed = await recoveredLog.getByState("completed");

    expect(completed).toHaveLength(1);
    expect(submitting).toHaveLength(1);
    expect(submitting[0]!.id).toBe("tx-2");
    expect(queued).toHaveLength(1);
    expect(queued[0]!.id).toBe("tx-3");
  });
});

describe("TransactionQueue — callback contract", () => {
  it("onSubmit fires for each successful submission", async () => {
    const submissions: string[] = [];
    const queue = fastQueue({ submit: jest.fn(async () => []) } as any, {
      onSubmit: (info) => submissions.push(info.txId),
    });

    await queue.enqueue(async () => []);
    await queue.enqueue(async () => []);
    await queue.close();

    expect(submissions).toHaveLength(2);
  });

  it("onDeadLetter fires with correct record", async () => {
    const deadLetters: TransactionRecord[] = [];
    const queue = fastQueue(
      async () => { throw nonTransientError("validation error"); },
      {
        maxRetries: 0,
        onDeadLetter: (rec) => deadLetters.push(rec),
      },
    );

    await expect(queue.enqueue(async () => { throw nonTransientError(); })).rejects.toThrow();

    expect(deadLetters).toHaveLength(1);
    expect(deadLetters[0]!.state).toBe("dead_lettered");
    expect(deadLetters[0]!.error).toBeDefined();
  });

  it("stateChange events emit for full lifecycle", async () => {
    const transitions: Array<{ from: TransactionState; to: TransactionState }> = [];
    const queue = fastQueue({ submit: jest.fn(async () => []) } as any);
    queue.on("stateChange", (_txId, from, to) => {
      transitions.push({ from, to });
    });

    await queue.enqueue(async () => []);

    expect(transitions).toEqual([
      { from: "queued", to: "submitting" },
      { from: "submitting", to: "completed" },
    ]);
  });

  it("drain event fires when queue empties", async () => {
    let drained = false;
    const queue = fastQueue({ submit: jest.fn(async () => []) } as any);
    queue.on("drain", () => { drained = true; });

    await queue.enqueue(async () => []);
    // Give the event a tick
    await delay(10);
    expect(drained).toBe(true);
  });

  it("error event fires on dead-letter", async () => {
    const errors: string[] = [];
    const queue = fastQueue(
      async () => { throw nonTransientError(); },
      { maxRetries: 0 },
    );
    queue.on("error", (txId) => errors.push(txId));

    await expect(queue.enqueue(async () => { throw nonTransientError(); })).rejects.toThrow();
    expect(errors).toHaveLength(1);
  });
});

describe("TransactionQueue — budget integration", () => {
  it("budget decreases after submissions", async () => {
    const queue = fastQueue({ submit: jest.fn(async () => []) } as any, {
      avgTxSizeBytes: 10_000,
    });

    const before = queue.bytesRemaining;
    await queue.enqueue(async () => []);
    const after = queue.bytesRemaining;

    expect(before - after).toBeCloseTo(10_000, -2);
  });

  it("utilization increases with submissions", async () => {
    const queue = fastQueue({ submit: jest.fn(async () => []) } as any, {
      avgTxSizeBytes: 50_000,
    });

    expect(queue.utilization).toBeCloseTo(0, 1);
    await queue.enqueue(async () => []);
    expect(queue.utilization).toBeGreaterThan(0.2);
  });

  it("getBudget() exposes the tracker for external calibration", async () => {
    const queue = fastQueue({ submit: jest.fn(async () => []) } as any);
    const budget = queue.getBudget();
    expect(budget).toBeDefined();

    budget.recordSubmission(100_000);
    expect(queue.bytesRemaining).toBeLessThan(200_000);
  });
});

describe("TransactionQueue — stress tests", () => {
  it("handles 50 concurrent enqueues", async () => {
    let count = 0;
    const ledger = {
      submit: jest.fn(async () => { count++; return []; }),
    } as unknown as Ledger;

    const queue = fastQueue(ledger);

    const promises = [];
    for (let i = 0; i < 50; i++) {
      promises.push(queue.enqueue(async () => ledger.submit([] as any)));
    }

    await Promise.all(promises);
    expect(count).toBe(50);
  }, 30_000);

  it("handles mixed success and failure in batch", async () => {
    let callNum = 0;
    const mixedLedger = {
      submit: jest.fn(async () => {
        callNum++;
        if (callNum % 3 === 0) throw nonTransientError("bad");
        return [];
      }),
    } as unknown as Ledger;

    const log = new InMemoryTransactionLog();
    const queue = fastQueue(mixedLedger, { maxRetries: 0, log });

    const results = await Promise.allSettled(
      Array.from({ length: 12 }, () =>
        queue.enqueue(async () => mixedLedger.submit([] as any)),
      ),
    );

    const fulfilled = results.filter((r) => r.status === "fulfilled").length;
    const rejected = results.filter((r) => r.status === "rejected").length;

    expect(fulfilled).toBe(8);  // 12 - 4 failures (every 3rd)
    expect(rejected).toBe(4);

    const all = await log.getAll();
    const completed = all.filter((r) => r.state === "completed");
    const dead = all.filter((r) => r.state === "dead_lettered");
    expect(completed.length).toBe(8);
    expect(dead.length).toBe(4);
  }, 30_000);

  it("new enqueue during drain processes correctly", async () => {
    const order: number[] = [];
    let enqueueMore: (() => void) | null = null;
    const ledger = {
      submit: jest.fn(async () => []),
    } as unknown as Ledger;

    const queue = fastQueue(ledger);

    // Enqueue first item
    const p1 = queue.enqueue(async () => {
      order.push(1);
      // Enqueue more while draining
      if (enqueueMore) enqueueMore();
      enqueueMore = null;
    });

    // Set up a callback to enqueue during first drain
    const p2Promise = new Promise<void>((resolve) => {
      enqueueMore = () => {
        queue.enqueue(async () => { order.push(2); resolve(); });
      };
    });

    await p1;
    await p2Promise;
    expect(order).toEqual([1, 2]);
  });
});

describe("TransactionQueue — edge cases", () => {
  it("transaction function that returns undefined", async () => {
    const queue = fastQueue({ submit: jest.fn(async () => []) } as any);
    const result = await queue.enqueue(async () => undefined);
    expect(result).toBeUndefined();
  });

  it("transaction function that returns a complex object", async () => {
    const queue = fastQueue({ submit: jest.fn(async () => []) } as any);
    const obj = { nested: { data: [1, 2, 3] }, flag: true };
    const result = await queue.enqueue(async () => obj);
    expect(result).toEqual(obj);
  });

  it("sizeEstimate overrides avgTxSizeBytes for budget", async () => {
    const queue = fastQueue({ submit: jest.fn(async () => []) } as any, {
      avgTxSizeBytes: 7000,
    });

    const before = queue.bytesRemaining;
    await queue.enqueue(async () => [], { sizeEstimate: 50_000 });
    const after = queue.bytesRemaining;

    // Should have deducted 50KB, not 7KB
    expect(before - after).toBeCloseTo(50_000, -2);
  });

  it("getSnapshot reflects accurate state during processing", async () => {
    const log = new InMemoryTransactionLog();
    const queue = fastQueue({ submit: jest.fn(async () => []) } as any, { log });

    // Enqueue 3 items
    const p1 = queue.enqueue(async () => "a");
    const p2 = queue.enqueue(async () => "b");
    const p3 = queue.enqueue(async () => "c");

    await Promise.all([p1, p2, p3]);

    const snapshot = await queue.getSnapshot();
    expect(snapshot.depth).toBe(0);
    expect(snapshot.transactions).toHaveLength(3);
    expect(snapshot.transactions.every((t) => t.state === "completed")).toBe(true);
  });

  it("close then close again is idempotent", async () => {
    const queue = fastQueue({ submit: jest.fn(async () => []) } as any);
    await queue.close();
    await queue.close(); // should not hang or throw
  });

  it("abort then abort again returns empty", async () => {
    const queue = fastQueue({ submit: jest.fn(async () => []) } as any);
    queue.enqueue(async () => "x").catch(() => {});
    const first = queue.abort();
    const second = queue.abort();
    expect(first.length).toBeGreaterThanOrEqual(0);
    expect(second).toEqual([]);
  });

  it("pause prevents drain, items accumulate", async () => {
    const queue = fastQueue({ submit: jest.fn(async () => []) } as any);
    queue.pause();

    queue.enqueue(async () => "a");
    queue.enqueue(async () => "b");
    queue.enqueue(async () => "c");

    await delay(200);
    // All 3 should still be queued
    const snapshot = await queue.getSnapshot();
    expect(snapshot.depth).toBe(3);
    expect(snapshot.paused).toBe(true);

    // Resume and drain
    queue.resume();
    await queue.close();

    const snapshot2 = await queue.getSnapshot();
    expect(snapshot2.depth).toBe(0);
  });
});

describe("TransactionQueue — close() waits for retrying entries (P1 fix)", () => {
  it("close() waits for entry in retry backoff to finish", async () => {
    let attempts = 0;
    const failOnceThenSucceed = jest.fn(async () => {
      attempts++;
      if (attempts === 1) throw transientError();
      return "recovered";
    });

    const queue = fastQueue(failOnceThenSucceed, {
      maxRetries: 3,
      baseRetryDelayMs: 50,
    });

    const txPromise = queue.enqueue(async () => failOnceThenSucceed());

    // Wait for first attempt to fail and enter retry backoff
    await delay(120);
    expect(attempts).toBe(1);

    // close() should NOT resolve until the retry completes
    await queue.close();
    expect(attempts).toBe(2);

    const result = await txPromise;
    expect(result).toBe("recovered");
  });

  it("close() waits for multiple retrying entries", async () => {
    let count = 0;
    const failOnceThenSucceed = jest.fn(async () => {
      count++;
      if (count <= 2) throw transientError();
      return "ok";
    });

    const queue = fastQueue(failOnceThenSucceed, {
      maxRetries: 3,
      baseRetryDelayMs: 30,
    });

    const p1 = queue.enqueue(async () => failOnceThenSucceed());
    const p2 = queue.enqueue(async () => failOnceThenSucceed());

    await queue.close();
    // Both should have completed (retried and succeeded)
    await expect(p1).resolves.toBe("ok");
    await expect(p2).resolves.toBe("ok");
  });
});

describe("TransactionQueue — commandId passthrough (P1 fix)", () => {
  it("enqueueCommands passes its commandId to ledger.submit", async () => {
    let capturedCommandId: string | undefined;
    const ledger = {
      submit: jest.fn(async (_cmds: any, _actAs: any, opts: any) => {
        capturedCommandId = opts?.commandId;
        return [];
      }),
    } as unknown as Ledger;

    const log = new InMemoryTransactionLog();
    const queue = fastQueue(ledger, { log });

    await queue.enqueueCommands([] as AnyCommand[]);

    // The commandId in the log should match what was passed to ledger.submit
    const all = await log.getAll();
    expect(all).toHaveLength(1);
    expect(capturedCommandId).toBeDefined();
    expect(all[0]!.commandId).toBe(capturedCommandId);
  });

  it("commandId starts with txq- prefix", async () => {
    let capturedCommandId: string | undefined;
    const ledger = {
      submit: jest.fn(async (_cmds: any, _actAs: any, opts: any) => {
        capturedCommandId = opts?.commandId;
        return [];
      }),
    } as unknown as Ledger;

    const queue = fastQueue(ledger);
    await queue.enqueueCommands([] as AnyCommand[]);
    expect(capturedCommandId).toMatch(/^txq-/);
  });
});

describe("TransactionQueue — retry respects priority ordering (P2 fix)", () => {
  it("retried low-priority entry does not jump ahead of high-priority entry", async () => {
    const order: string[] = [];
    let attempts = 0;
    const failOnceThenLog = jest.fn(async () => {
      attempts++;
      if (attempts === 1) throw transientError();
      order.push("retried-low");
      return "ok";
    });

    const queue = fastQueue(
      { submit: jest.fn(async () => []) } as any,
      { maxRetries: 3, baseRetryDelayMs: 100 },
    );

    // Enqueue low-priority that will fail once
    const pLow = queue.enqueue(async () => failOnceThenLog(), { priority: 0 });

    // Wait for it to fail and enter retry backoff
    await delay(120);
    expect(attempts).toBe(1);

    // Now enqueue a high-priority item while the retry is pending
    const pHigh = queue.enqueue(async () => {
      order.push("high");
      return "urgent";
    }, { priority: 100 });

    // Wait for both to complete
    await Promise.all([pLow.catch(() => {}), pHigh]);

    // High-priority should have executed before the retried low-priority
    expect(order[0]).toBe("high");
    expect(order[1]).toBe("retried-low");
  });
});
