/**
 * Traffic-aware transaction queue for Canton's CIP-104 base rate limits.
 *
 * Wraps a Ledger instance to throttle submissions within the free traffic
 * budget, avoiding sequencer rejections and extra traffic costs ($60/MB).
 *
 * Two modes:
 * - "size-aware": Uses PrepareSubmission for exact cost estimation (Phase 2)
 * - "time-spread": Distributes transactions evenly over a time window
 *
 * Every transaction is tracked through a full lifecycle with pluggable
 * persistence via TransactionLog.
 */
import { EventEmitter } from "eventemitter3";
import { logger } from "./logger";
import { BudgetTracker, type BudgetSnapshot } from "./budget-tracker";
import {
  InMemoryTransactionLog,
  type TransactionLog,
  type TransactionRecord,
  type TransactionState,
} from "./transaction-log";
import { convertCommand, type Ledger } from "./ledger";
import type { AnyCommand, Event } from "./types";
import type { LedgerApiError } from "./client";
import type { Party } from "@daml/types";

/**
 * Estimate the JSON-serialized byte size of Daml commands.
 *
 * This measures the JSON payload that would be sent to Canton's JSON API v2.
 * It's a rough proxy for the actual protobuf envelope size that Canton charges
 * for traffic — typically the envelope is smaller than JSON, so this is a
 * conservative overestimate. Useful for:
 * - Calibrating `avgTxSizeBytes` for time-spread mode
 * - Debugging which transactions are unexpectedly large
 * - Comparing relative sizes between different transaction types
 *
 * For exact traffic cost, use `Ledger.prepareSubmission()` which returns
 * `CostEstimation.totalTrafficCostEstimation` from the Canton engine.
 */
export function estimateCommandsJsonSize(commands: AnyCommand[]): number {
  const jsCommands = commands.map((command) => convertCommand(command));
  return new TextEncoder().encode(JSON.stringify(jsCommands)).byteLength;
}

// ── Options ───────────────────────────────────────────────────────

export interface TransactionQueueOptions {
  /** The Ledger instance to submit through. */
  ledger: Ledger;

  /**
   * Traffic budget in bytes per window.
   * Mainnet (live 2026-04-04): 200,000 bytes (~195 KB).
   * IMPORTANT: Query AmuletRules for the live value — SVs can change this.
   */
  budgetBytes: number;

  /**
   * Budget recovery window in ms.
   * Mainnet: 1,200,000 ms (20 minutes).
   */
  windowMs: number;

  /**
   * Safety margin (0–1). Reserve this fraction of budget as buffer.
   * Default: 0.1 (10%).
   */
  safetyMargin?: number;

  /**
   * Queuing mode:
   * - "time-spread": Distributes evenly over spreadPeriodMs without size measurement
   * - "size-aware": Uses PrepareSubmission for exact cost estimation (future)
   */
  mode: "time-spread" | "size-aware";

  /**
   * For time-spread mode: target period over which to spread transactions.
   * Defaults to windowMs.
   */
  spreadPeriodMs?: number;

  /**
   * For time-spread mode: assumed average transaction size in bytes.
   * Used to calculate how many transactions fit per window.
   * Default: 7000 (7 KB — typical for 7Trust verify+marker txns).
   */
  avgTxSizeBytes?: number;

  /**
   * Maximum retry attempts for transient failures before dead-lettering.
   * Default: 3.
   */
  maxRetries?: number;

  /**
   * Base delay in ms for exponential backoff on retries.
   * Actual delay: baseRetryDelayMs * 2^attempt, capped at 30s.
   * Default: 1000.
   */
  baseRetryDelayMs?: number;

  /**
   * Transaction log for lifecycle persistence.
   * Default: InMemoryTransactionLog.
   */
  log?: TransactionLog;

  /** Callbacks */
  onThrottle?: (info: ThrottleInfo) => void;
  onSubmit?: (info: SubmitInfo) => void;
  onDeadLetter?: (record: TransactionRecord) => void;
}

export interface ThrottleInfo {
  txId: string;
  queueDepth: number;
  bytesRemaining: number;
  estimatedWaitMs: number;
}

export interface SubmitInfo {
  txId: string;
  commandId: string;
  estimatedBytes: number;
  actualBytes?: number;
  /** JSON-serialized byte size of the commands (if available). */
  jsonSizeBytes?: number;
  budgetUtilization: number;
}

// ── Queue events ──────────────────────────────────────────────────

export interface TransactionQueueEvents {
  stateChange: (txId: string, from: TransactionState, to: TransactionState) => void;
  drain: () => void;
  error: (txId: string, error: Error) => void;
}

// ── Internal entry ────────────────────────────────────────────────

interface QueueEntry<R> {
  record: TransactionRecord;
  txFn: () => Promise<R>;
  resolve: (result: R) => void;
  reject: (error: Error) => void;
}

// ── Queue snapshot for health checks ──────────────────────────────

export interface QueueSnapshot {
  depth: number;
  budget: BudgetSnapshot;
  paused: boolean;
  transactions: TransactionRecord[];
}

// ── Shutdown state ────────────────────────────────────────────────

type ShutdownState = "open" | "closing" | "aborted";

// ── TransactionQueue ──────────────────────────────────────────────

export class TransactionQueue extends EventEmitter<TransactionQueueEvents> {
  private readonly ledger: Ledger;
  private readonly budget: BudgetTracker;
  private readonly txLog: TransactionLog;
  private readonly mode: "time-spread" | "size-aware";
  private readonly maxRetries: number;
  private readonly baseRetryDelayMs: number;
  private readonly avgTxSizeBytes: number;
  private readonly spreadPeriodMs: number;
  private readonly onThrottle?: (info: ThrottleInfo) => void;
  private readonly onSubmit?: (info: SubmitInfo) => void;
  private readonly onDeadLetter?: (record: TransactionRecord) => void;

  private queue: QueueEntry<any>[] = [];
  private drainTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimers = new Map<ReturnType<typeof setTimeout>, QueueEntry<any>>();
  private inflight = 0;
  private paused = false;
  private shutdownState: ShutdownState = "open";
  private draining = false;
  private closeResolvers: Array<() => void> = [];

  constructor(options: TransactionQueueOptions) {
    super();
    this.ledger = options.ledger;
    this.mode = options.mode;
    this.maxRetries = options.maxRetries ?? 3;
    this.baseRetryDelayMs = options.baseRetryDelayMs ?? 1000;
    this.avgTxSizeBytes = options.avgTxSizeBytes ?? 7000;
    this.spreadPeriodMs = options.spreadPeriodMs ?? options.windowMs;
    this.onThrottle = options.onThrottle;
    this.onSubmit = options.onSubmit;
    this.onDeadLetter = options.onDeadLetter;

    this.budget = new BudgetTracker({
      burstAmount: options.budgetBytes,
      burstWindowMs: options.windowMs,
      safetyMargin: options.safetyMargin,
    });

    this.txLog = options.log ?? new InMemoryTransactionLog();
  }

  /**
   * Enqueue a transaction function for throttled submission.
   * Returns a promise that resolves with the result when the tx actually executes.
   */
  enqueue<R>(
    txFn: () => Promise<R>,
    options?: { priority?: number; sizeEstimate?: number; tag?: string },
  ): Promise<R> {
    if (this.shutdownState !== "open") {
      return Promise.reject(new Error("TransactionQueue is closed"));
    }

    const priority = options?.priority ?? 0;
    const id = this.generateId();
    const commandId = `txq-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    const now = new Date().toISOString();

    const record: TransactionRecord = {
      id,
      commandId,
      state: "queued",
      costEstimate: options?.sizeEstimate ?? this.avgTxSizeBytes,
      retryCount: 0,
      enqueuedAt: now,
      updatedAt: now,
      priority,
      tag: options?.tag,
    };

    const promise = new Promise<R>((resolve, reject) => {
      const entry: QueueEntry<R> = { record, txFn, resolve, reject };
      this.insertByPriority(entry);
    });

    // Await the initial log write to ensure ordering before any
    // state transitions — prevents "queued" landing after "completed" in JSONL
    this.txLog.record(record).catch((err) => {
      logger.error(`Failed to log transaction ${id}: ${err}`);
    }).then(() => {
      this.scheduleDrain();
    });

    return promise;
  }

  /**
   * Enqueue raw Daml commands for throttled submission.
   * Passes the queue's commandId through to Ledger.submit() so the JSONL
   * log records the same commandId that Canton uses for deduplication.
   */
  enqueueCommands(
    commands: AnyCommand[],
    actAs?: Party[],
    options?: { priority?: number; sizeEstimate?: number; tag?: string },
  ): Promise<Event<object, unknown>[]> {
    // Generate the commandId up front so it's recorded in the TransactionRecord
    // AND passed through to the actual Canton submission
    const commandId = `txq-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

    if (this.shutdownState !== "open") {
      return Promise.reject(new Error("TransactionQueue is closed"));
    }

    const priority = options?.priority ?? 0;
    const id = this.generateId();
    const now = new Date().toISOString();

    const jsonSizeBytes = estimateCommandsJsonSize(commands);

    const record: TransactionRecord = {
      id,
      commandId,
      state: "queued",
      costEstimate: options?.sizeEstimate ?? this.avgTxSizeBytes,
      jsonSizeBytes,
      retryCount: 0,
      enqueuedAt: now,
      updatedAt: now,
      priority,
      tag: options?.tag,
    };

    const promise = new Promise<Event<object, unknown>[]>((resolve, reject) => {
      const entry: QueueEntry<Event<object, unknown>[]> = {
        record,
        txFn: () => this.ledger.submit(commands, actAs, { commandId }),
        resolve,
        reject,
      };
      this.insertByPriority(entry);
    });

    this.txLog.record(record).catch((err) => {
      logger.error(`Failed to log transaction ${id}: ${err}`);
    }).then(() => {
      this.scheduleDrain();
    });

    return promise;
  }

  /** Current queue depth (waiting, not including in-flight or retrying). */
  get depth(): number {
    return this.queue.length;
  }

  /** Estimated bytes consumed within the current recovery window. */
  get bytesUsedInWindow(): number {
    const snap = this.budget.snapshot();
    return snap.burstAmount - snap.balance;
  }

  /** Estimated bytes available before throttling. */
  get bytesRemaining(): number {
    return this.budget.getAvailableBalance();
  }

  /** Current budget utilization (0–1). */
  get utilization(): number {
    return this.budget.snapshot().utilization;
  }

  /** Pause the queue (stops draining, keeps items). */
  pause(): void {
    this.paused = true;
    if (this.drainTimer) {
      clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }
  }

  /** Resume the queue. */
  resume(): void {
    this.paused = false;
    this.scheduleDrain();
  }

  /**
   * Graceful close — waits for all queued, in-flight, AND retrying items
   * to complete, then resolves. No new enqueues accepted after calling.
   */
  async close(): Promise<void> {
    this.shutdownState = "closing";
    if (this.isFullyDrained()) return;
    return new Promise<void>((resolve) => {
      this.closeResolvers.push(resolve);
      this.scheduleDrain();
    });
  }

  /**
   * Abort — rejects all pending and retrying items, returns their records.
   * In-flight transactions (currently submitting) are NOT cancelled.
   */
  abort(): TransactionRecord[] {
    this.shutdownState = "aborted";
    if (this.drainTimer) {
      clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }

    const aborted: TransactionRecord[] = [];
    const abortError = new Error("TransactionQueue aborted");

    // Cancel all pending retry timers and reject their entries
    for (const [timer, entry] of this.retryTimers) {
      clearTimeout(timer);
      entry.record.state = "dead_lettered";
      entry.record.updatedAt = new Date().toISOString();
      entry.record.error = "Queue aborted during retry backoff";
      aborted.push({ ...entry.record });
      entry.reject(abortError);
      this.txLog.record(entry.record).catch(() => {});
    }
    this.retryTimers.clear();

    for (const entry of this.queue) {
      entry.record.state = "dead_lettered";
      entry.record.updatedAt = new Date().toISOString();
      entry.record.error = "Queue aborted";
      aborted.push({ ...entry.record });
      entry.reject(abortError);
      this.txLog.record(entry.record).catch(() => {});
    }

    this.queue = [];
    return aborted;
  }

  /** Full snapshot for health checks. */
  async getSnapshot(): Promise<QueueSnapshot> {
    return {
      depth: this.queue.length,
      budget: this.budget.snapshot(),
      paused: this.paused,
      transactions: await this.txLog.getAll(),
    };
  }

  /** Access the underlying transaction log (e.g. for recovery on restart). */
  getLog(): TransactionLog {
    return this.txLog;
  }

  /** Access the underlying budget tracker. */
  getBudget(): BudgetTracker {
    return this.budget;
  }

  // ── Internal ──────────────────────────────────────────────────

  private generateId(): string {
    return `txq-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
  }

  /** Insert entry into the queue sorted by priority (highest first). */
  private insertByPriority(entry: QueueEntry<any>): void {
    const priority = entry.record.priority;
    const insertIdx = this.queue.findIndex((e) => e.record.priority < priority);
    if (insertIdx === -1) {
      this.queue.push(entry);
    } else {
      this.queue.splice(insertIdx, 0, entry);
    }
  }

  /** Check if all work is done: queue empty, nothing in-flight, no retries pending. */
  private isFullyDrained(): boolean {
    return this.queue.length === 0 && this.inflight === 0 && this.retryTimers.size === 0;
  }

  /** Try to resolve all close waiters if all work is done. */
  private checkDrainComplete(): void {
    if (this.isFullyDrained()) {
      this.emit("drain");
      for (const resolve of this.closeResolvers) resolve();
      this.closeResolvers = [];
    }
  }

  private scheduleDrain(): void {
    if (this.paused || this.drainTimer || this.queue.length === 0) return;

    if (this.mode === "time-spread") {
      this.scheduleTimeSpreadDrain();
    } else {
      this.scheduleSizeAwareDrain();
    }
  }

  private scheduleTimeSpreadDrain(): void {
    const txnsPerWindow = this.budget.getEffectiveBudget() / this.avgTxSizeBytes;
    const delayMs = Math.max(50, this.spreadPeriodMs / txnsPerWindow);

    this.drainTimer = setTimeout(() => {
      this.drainTimer = null;
      this.drainOne();
    }, delayMs);
  }

  private scheduleSizeAwareDrain(): void {
    const next = this.queue[0];
    if (!next) return;

    const waitMs = this.budget.estimateWaitMs(next.record.costEstimate ?? this.avgTxSizeBytes);
    if (waitMs > 0) {
      this.onThrottle?.({
        txId: next.record.id,
        queueDepth: this.queue.length,
        bytesRemaining: this.budget.getAvailableBalance(),
        estimatedWaitMs: waitMs,
      });
    }

    this.drainTimer = setTimeout(() => {
      this.drainTimer = null;
      this.drainOne();
    }, Math.max(50, waitMs));
  }

  private async drainOne(): Promise<void> {
    if (this.paused || this.queue.length === 0) return;
    if (this.draining) return; // prevent re-entrance
    this.draining = true;

    const entry = this.queue[0]!;
    const costEstimate = entry.record.costEstimate ?? this.avgTxSizeBytes;

    // In size-aware mode, check if the transaction can ever fit
    if (this.mode === "size-aware") {
      const waitMs = this.budget.estimateWaitMs(costEstimate);
      if (waitMs === Infinity) {
        // Transaction is larger than the effective budget — it can never be submitted
        this.queue.shift();
        this.draining = false;
        entry.record.error = `Transaction estimate (${costEstimate} bytes) exceeds effective budget (${this.budget.getEffectiveBudget()} bytes)`;
        await this.safeTransition(entry, "dead_lettered");
        logger.error(`Transaction ${entry.record.id} dead-lettered: ${entry.record.error}`);
        this.onDeadLetter?.({ ...entry.record });
        this.emit("error", entry.record.id, new Error(entry.record.error));
        entry.reject(new Error(entry.record.error));
        if (this.queue.length > 0) {
          this.scheduleDrain();
        } else {
          this.checkDrainComplete();
        }
        return;
      }
      if (!this.budget.canSubmit(costEstimate)) {
        this.draining = false;
        this.scheduleDrain();
        return;
      }
    }

    // Remove from queue and track as in-flight
    this.queue.shift();
    this.inflight++;

    // Transition to submitting — log failure must not wedge the queue
    await this.safeTransition(entry, "submitting");

    // Record budget consumption
    this.budget.recordSubmission(costEstimate);

    try {
      const result = await entry.txFn();

      // Success
      entry.record.state = "completed";
      entry.record.updatedAt = new Date().toISOString();
      await this.txLog.record(entry.record).catch((logErr) => {
        logger.error(`Failed to log completion for ${entry.record.id}: ${logErr}`);
      });
      this.emit("stateChange", entry.record.id, "submitting", "completed");

      const jsonSize = entry.record.jsonSizeBytes;
      if (jsonSize !== undefined) {
        logger.debug(
          `Transaction ${entry.record.id} completed — ` +
            `JSON size: ${jsonSize} bytes, budget estimate: ${costEstimate} bytes` +
            (entry.record.tag ? `, tag: ${entry.record.tag}` : ""),
        );
      }

      this.onSubmit?.({
        txId: entry.record.id,
        commandId: entry.record.commandId,
        estimatedBytes: costEstimate,
        jsonSizeBytes: jsonSize,
        budgetUtilization: this.budget.snapshot().utilization,
      });

      entry.resolve(result);
    } catch (err: any) {
      await this.handleFailure(entry, err, costEstimate);
    }

    this.inflight--;
    this.draining = false;

    // Continue draining or signal completion
    if (this.queue.length > 0) {
      this.scheduleDrain();
    } else {
      this.checkDrainComplete();
    }
  }

  private async handleFailure(
    entry: QueueEntry<any>,
    err: Error,
    costEstimate: number,
  ): Promise<void> {
    const isTransient = this.isTransientError(err);

    if (isTransient && entry.record.retryCount < this.maxRetries) {
      // Retry with backoff
      entry.record.retryCount++;
      entry.record.error = err.message;
      await this.safeTransition(entry, "retrying");

      const backoff = Math.min(
        30_000,
        this.baseRetryDelayMs * Math.pow(2, entry.record.retryCount - 1),
      );

      logger.warn(
        `Transaction ${entry.record.id} failed (attempt ${entry.record.retryCount}/${this.maxRetries}), ` +
          `retrying in ${backoff}ms: ${err.message}`,
      );

      // Only refund budget for errors where we're confident the command was
      // NOT accepted. For ambiguous network errors (ETIMEDOUT, FetchError),
      // the command may have been accepted and charged before the response was
      // lost — refunding would make our local balance too high.
      if (this.isDefinitelyNotAccepted(err)) {
        this.budget.recalibrateFromActual(costEstimate, 0);
      }

      const retryTimer = setTimeout(() => {
        this.retryTimers.delete(retryTimer);

        // Only dead-letter on hard abort — closing should let retries finish
        if (this.shutdownState === "aborted") {
          entry.record.state = "dead_lettered";
          entry.record.updatedAt = new Date().toISOString();
          entry.record.error = "Queue aborted during retry backoff";
          this.txLog.record(entry.record).catch(() => {});
          entry.reject(new Error("TransactionQueue aborted"));
          return;
        }

        // Re-insert respecting priority ordering
        this.insertByPriority(entry);
        this.scheduleDrain();
      }, backoff);
      this.retryTimers.set(retryTimer, entry);
    } else {
      // Dead-letter
      entry.record.error = err.message;
      await this.safeTransition(entry, "dead_lettered");

      logger.error(
        `Transaction ${entry.record.id} dead-lettered after ${entry.record.retryCount} retries: ${err.message}`,
      );

      this.onDeadLetter?.({ ...entry.record });
      this.emit("error", entry.record.id, err);
      entry.reject(err);
    }
  }

  private isTransientError(err: any): boolean {
    // Network errors
    if (err.name === "FetchError" || err.code === "ECONNREFUSED" || err.code === "ETIMEDOUT") {
      return true;
    }
    // HTTP 5xx or 429 (rate limit) from Canton
    if (typeof err.status === "number") {
      return err.status >= 500 || err.status === 429;
    }
    return false;
  }

  /**
   * Returns true for errors where we're confident Canton did NOT accept the
   * command. For ambiguous network errors (timeout, connection reset), the
   * command may have been processed — we can't safely refund the budget.
   */
  private isDefinitelyNotAccepted(err: any): boolean {
    // Connection refused = server never saw the request
    if (err.code === "ECONNREFUSED") return true;
    // HTTP 5xx with a response = server received but rejected
    if (typeof err.status === "number" && err.status >= 500) return true;
    // HTTP 429 = rate-limited before processing
    if (typeof err.status === "number" && err.status === 429) return true;
    // FetchError / ETIMEDOUT = ambiguous — response may have been lost
    return false;
  }

  private async transition(entry: QueueEntry<any>, to: TransactionState): Promise<void> {
    const from = entry.record.state;
    entry.record.state = to;
    entry.record.updatedAt = new Date().toISOString();
    await this.txLog.record(entry.record);
    this.emit("stateChange", entry.record.id, from, to);
  }

  /** Like transition() but catches log I/O failures instead of throwing. */
  private async safeTransition(entry: QueueEntry<any>, to: TransactionState): Promise<void> {
    try {
      await this.transition(entry, to);
    } catch (logErr) {
      // Log failure must not wedge the queue — degrade gracefully
      logger.error(`Failed to log transition to ${to} for ${entry.record.id}: ${logErr}`);
      // Still update the in-memory state so the queue can continue
      entry.record.state = to;
      entry.record.updatedAt = new Date().toISOString();
    }
  }
}
