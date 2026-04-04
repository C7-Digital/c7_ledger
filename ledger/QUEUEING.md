# TransactionQueue — Design & Operations Guide

## Why This Exists

Canton's CIP-104 introduces a **base rate traffic limit** per participant node. Every transaction consumes traffic measured by the serialized protobuf envelope size. Each participant gets a free "burst" budget that recovers linearly over a window:

| Parameter | Mainnet Value (2026-04-04) | Source |
|-----------|---------------------------|--------|
| Burst amount | **200,000 bytes (~195 KB)** | Live `AmuletRules` via Scan API |
| Burst window | 1,200,000 ms (20 minutes) | `SynchronizerFeesConfig` |
| Recovery rate | ~167 bytes/second | Derived: 200,000 / 1,200 |
| Extra traffic price | **$60 USD/MB** | `SynchronizerFeesConfig` |

**If you exceed the burst budget, the sequencer rejects your transaction.** It doesn't queue it — it's gone. Your application must retry, and the retry consumes even more traffic.

The `TransactionQueue` solves this by throttling submissions to stay within the free budget. Applications that do batch operations (7Trust's 1,750+ domain verifications, PartyPopulateService's bulk address book creation) are the primary consumers.

> **Important**: The documented default burst is 400KB, but the live mainnet value is 200KB. SVs can change this via governance vote. Always query `AmuletRules` for the live value — don't trust documentation or code defaults.

---

## Architecture Decision

We chose a **wrapper class** over middleware interception or `Ledger` subclassing:

- **Zero changes to `Ledger`** — no breaking changes for existing consumers. The only addition to `Ledger` is an optional `commandId` parameter on `submit()` and the new `prepareSubmission()` method.
- **Opt-in** — applications explicitly construct a queue. Existing code that calls `ledger.submit()` directly is unaffected.
- **Composable** — the queue works with any `Ledger` method via `enqueue()`, or specifically with `submit()` via `enqueueCommands()`.
- **Testable** — independently unit-testable with a mock ledger. No need to spin up Canton.

```
Application code
    │
    ├── ledger.submit(commands)              ← direct, no throttling
    │
    └── queue.enqueueCommands(commands)      ← throttled, tracked, retried
            │
            └── ledger.submit(commands, actAs, { commandId })
```

---

## How the Budget Model Works

The `BudgetTracker` maintains a local estimate of the participant's base rate balance. Since **no Canton API exposes the actual balance**, we model it ourselves:

```
balance starts at burstAmount (e.g. 200,000 bytes)
    │
    ├── on submission: balance -= estimatedBytes
    │
    ├── over time: balance += recoveryRate × elapsed_ms
    │                (capped at burstAmount)
    │
    └── safety margin: effective budget = burstAmount × (1 - safetyMargin)
                       canSubmit() checks against effective, not raw
```

### Safety Margin

The `safetyMargin` (default 10%) reserves a fraction of the budget for traffic the queue doesn't control:

- **ACS commitment exchanges** — Canton periodically syncs active contract state between participants
- **Topology transactions** — party/key management updates
- **Other applications** — if multiple apps share a participant, they compete for the same budget

A 15% margin is recommended for production participants running multiple apps.

### Recovery Math

With mainnet parameters (200KB / 20 min):

```
Recovery rate = 200,000 / 1,200,000 ≈ 0.167 bytes/ms ≈ 167 bytes/sec

Time to recover 10KB: 10,000 / 0.167 ≈ 60,000ms (1 minute)
Time to recover full budget: 1,200,000ms (20 minutes)

With 10% safety margin:
  Effective budget = 180,000 bytes
  Max transactions per window at 7KB each ≈ 25
  Inter-transaction delay = 1,200,000 / 25 ≈ 48 seconds
```

---

## Queuing Modes

### Time-Spread Mode (Available Now)

Distributes transactions evenly over the `spreadPeriodMs` window based on the assumed `avgTxSizeBytes`. No per-transaction measurement — it's a simple rate limiter.

```
delay between txns = spreadPeriodMs / (effectiveBudget / avgTxSizeBytes)
```

**When to use**: When you know your transactions are roughly uniform size (e.g. 7Trust's VerifyOwnership + ActivityMarker commands are consistently ~5-10KB).

**Trade-off**: If transactions vary widely in size, you'll under-utilize the budget (conservative) or over-utilize it (risky). Use `estimateCommandsJsonSize()` on a sample of your commands to calibrate `avgTxSizeBytes`.

### Size-Aware Mode (Phase 2 — Future)

Uses Canton's `PrepareSubmission` API to get the exact traffic cost before committing. The queue calls `PrepareSubmission` immediately on enqueue, then defers `ExecuteSubmission` until the budget allows.

**When to use**: When transactions vary significantly in size, or when you need precise budget management.

**Current status**: The `Ledger.prepareSubmission()` method is implemented and available, but the queue's size-aware drain loop is not yet wired up. Use time-spread mode for now.

> Note: `PrepareSubmission` is available via Canton's JSON API v2 at `/v2/interactive-submission/prepare`. It requires only read authorization (not actAs) since it doesn't execute the transaction.

---

## Transaction Lifecycle

Every transaction tracked by the queue goes through a state machine:

```
queued ──→ submitting ──→ completed
               │
               ↓
            failed ──→ retrying ──→ submitting ──→ ...
                                        │
                                        ↓
                                   dead_lettered
```

### States

| State | Meaning |
|-------|---------|
| `queued` | Enqueued, waiting for budget/scheduling to allow submission |
| `submitting` | Removed from queue, `txFn()` is executing |
| `completed` | `txFn()` resolved successfully |
| `failed` | `txFn()` threw — evaluating whether to retry |
| `retrying` | Waiting in exponential backoff before re-submission |
| `dead_lettered` | Permanently failed — max retries exhausted, or oversized, or aborted |

### TransactionRecord

Each transaction carries a `TransactionRecord` through its lifecycle:

```typescript
{
  id: "txq-1712345678-abc123def",      // Queue-generated unique ID
  commandId: "txq-1712345678-xyz789",   // Canton command ID (for dedup)
  state: "completed",
  costEstimate: 7000,                    // Budget bytes charged
  jsonSizeBytes: 4523,                   // Actual JSON payload size (if via enqueueCommands)
  actualCost: undefined,                 // From paid_traffic_cost (future)
  retryCount: 1,
  enqueuedAt: "2026-04-04T10:00:00Z",
  updatedAt: "2026-04-04T10:00:48Z",
  priority: 0,
  tag: "verify:example.com",
  error: undefined
}
```

---

## Reliability Design

### The Core Problem

An in-memory-only queue loses transactions on server crash. Worse, a transaction might be submitted to Canton but the server crashes before recording the result — leaving the queue's log in an inconsistent state.

### Transaction Log

The `TransactionLog` interface is called on every state transition. Two implementations ship:

**`InMemoryTransactionLog`** — Default. Good for development and testing. Lost on process exit.

**`JsonlTransactionLog`** — Append-only JSON Lines file. Each line is a complete `TransactionRecord` snapshot at the time of transition. On read, the last entry per ID wins.

```
{"id":"tx-1","state":"queued","commandId":"txq-...","updatedAt":"..."}
{"id":"tx-1","state":"submitting","commandId":"txq-...","updatedAt":"..."}
{"id":"tx-1","state":"completed","commandId":"txq-...","updatedAt":"..."}
{"id":"tx-2","state":"queued","commandId":"txq-...","updatedAt":"..."}
{"id":"tx-2","state":"submitting","commandId":"txq-...","updatedAt":"..."}
  ← server crashes here — tx-2 was submitted but we don't know the result
```

### Ordering Guarantee

The queue awaits the `record("queued")` write before scheduling the drain. This ensures JSONL entries are always ordered: `queued` appears before `submitting` appears before `completed` for any given transaction ID.

### Log Failure Resilience

If the log's `record()` call fails (disk full, permissions error), the queue degrades gracefully via `safeTransition()` — the in-memory state is still updated and the drain loop continues. The queue logs the failure but doesn't wedge.

### Recovery After Crash

On restart, read the JSONL log to find transactions in ambiguous states:

```typescript
const log = new JsonlTransactionLog("/var/data/txqueue.jsonl");

const submitting = await log.getByState("submitting");
// These were in-flight when the server crashed.
// The command may or may not have landed on Canton.

for (const record of submitting) {
  // Use the commandId to check Canton's completions stream.
  // Canton deduplicates by (userId, actAs, commandId), so re-submitting
  // a completed command is safe — it returns the original result.
  console.log(`Check completions for commandId: ${record.commandId}`);
}

const queued = await log.getByState("queued");
// These never started — safe to re-enqueue.
```

### Command ID Passthrough

When using `enqueueCommands()`, the queue generates the `commandId` up front and passes it through to `Ledger.submit()`. This means:

1. The JSONL log records the **same** commandId that Canton uses for deduplication
2. On crash recovery, you can look up the actual command on Canton's completions stream
3. Re-submitting with the same commandId is idempotent (Canton dedup)

When using generic `enqueue()` with a custom `txFn`, the `commandId` on the record is queue-internal — the actual Canton command ID depends on what your function does.

---

## Retry Semantics

### What Gets Retried

| Error Type | Retried? | Budget Refunded? | Rationale |
|-----------|----------|-----------------|-----------|
| HTTP 5xx | Yes | Yes | Server rejected before processing |
| HTTP 429 | Yes | Yes | Rate-limited before processing |
| `ECONNREFUSED` | Yes | Yes | Server never saw the request |
| `ETIMEDOUT` | Yes | **No** | Ambiguous — Canton may have processed it |
| `FetchError` | Yes | **No** | Ambiguous — response may have been lost |
| HTTP 4xx | **No** | No | Client error, won't succeed on retry |
| Other errors | **No** | No | Unknown, treated as permanent |

### Why Ambiguous Errors Don't Refund Budget

When a network timeout occurs, we don't know whether Canton:
1. Never received the command (safe to refund), or
2. Received, processed, and charged traffic, but the response was lost

If we always refund, our local balance becomes too optimistic. The next submission might push us over the real limit and get rejected by the sequencer. Since the retry will be deduplicated by `commandId` if the original succeeded, keeping the budget reserved is the conservative choice.

### Backoff

Exponential backoff: `min(30_000, baseRetryDelayMs × 2^(attempt-1))`

With default `baseRetryDelayMs: 1000`:
- Attempt 1: 1s
- Attempt 2: 2s
- Attempt 3: 4s (then dead-lettered if `maxRetries: 3`)

### Dead-Lettering

After `maxRetries` attempts, the transaction is dead-lettered:
- State set to `dead_lettered` with the error message
- `onDeadLetter` callback fires
- `"error"` event emitted
- The enqueue promise rejects with the original error

Dead-lettered transactions remain in the log for diagnostics. The application decides what to do — log, alert, or queue for manual review.

---

## Shutdown Semantics

The queue distinguishes between **graceful close** and **hard abort**:

### `close()` — Graceful Shutdown

- Stops accepting new `enqueue()` calls
- Waits for all queued, in-flight, AND retrying transactions to complete
- Retries continue through their backoff cycle — they are not dead-lettered
- Multiple `close()` calls are safe — all callers resolve when draining finishes
- Returns a promise that resolves when everything is done

```typescript
// Safe shutdown pattern
process.on("SIGTERM", async () => {
  await queue.close();
  process.exit(0);
});
```

### `abort()` — Hard Stop

- Stops accepting new `enqueue()` calls
- Rejects all queued transactions immediately
- Cancels all pending retry timers and rejects those entries
- Returns the list of dead-lettered `TransactionRecord`s
- In-flight transactions (currently awaiting `txFn()`) are NOT cancelled — they'll complete but their result is discarded

```typescript
// Emergency shutdown
const aborted = queue.abort();
console.log(`Aborted ${aborted.length} transactions`);
```

---

## Estimating Transaction Size

### `estimateCommandsJsonSize(commands)`

Standalone utility that converts commands to Canton's JSON format and measures byte size. This is a **conservative overestimate** — the actual protobuf envelope is typically smaller than JSON.

```typescript
import { estimateCommandsJsonSize, exerciseCmd } from "@c7-digital/ledger";

const commands = [
  exerciseCmd(cid, MyTemplate.Verify, {}),
  exerciseCmd(featuredAppCid, FeaturedAppRight.CreateActivityMarker, { beneficiaries }),
];

const size = estimateCommandsJsonSize(commands);
console.log(`Estimated JSON size: ${size} bytes`);
// Use this to calibrate avgTxSizeBytes
```

### Automatic Measurement via `enqueueCommands()`

When using `enqueueCommands()`, the JSON size is automatically measured and stored on the `TransactionRecord` as `jsonSizeBytes`. It's also:

- Persisted in the JSONL log (for post-hoc analysis)
- Included in the `onSubmit` callback as `SubmitInfo.jsonSizeBytes`
- Logged at debug level on completion

This lets you calibrate `avgTxSizeBytes` from real data:

```typescript
const sizes: number[] = [];
const queue = new TransactionQueue({
  // ...
  onSubmit: (info) => {
    if (info.jsonSizeBytes) sizes.push(info.jsonSizeBytes);
  },
});

// After a batch run:
const avg = sizes.reduce((a, b) => a + b, 0) / sizes.length;
console.log(`Average JSON size: ${avg} bytes — use this for avgTxSizeBytes`);
```

### JSON vs Protobuf vs Traffic Cost

| Measurement | What It Measures | Accuracy for Budgeting |
|-------------|-----------------|----------------------|
| `estimateCommandsJsonSize()` | JSON payload bytes | Conservative overestimate |
| `Ledger.prepareSubmission()` → `costEstimation` | Actual protobuf envelope cost | Exact (from Canton engine) |
| `paid_traffic_cost` on completion | Actual charged traffic | Ground truth (post-facto) |

For time-spread mode, the JSON estimate is good enough — you're rate-limiting by time, not by exact bytes. For size-aware mode (future), PrepareSubmission provides exact numbers.

---

## Configuration Guide

### Minimal Setup

```typescript
const queue = new TransactionQueue({
  ledger,
  budgetBytes: 200_000,       // Query AmuletRules for live value
  windowMs: 20 * 60 * 1000,
  mode: "time-spread",
});
```

### Production Setup

```typescript
const queue = new TransactionQueue({
  ledger,
  budgetBytes: 200_000,
  windowMs: 20 * 60 * 1000,
  safetyMargin: 0.15,           // 15% buffer for background traffic
  mode: "time-spread",
  avgTxSizeBytes: 7000,         // Calibrated from estimateCommandsJsonSize()
  spreadPeriodMs: 20 * 60 * 1000,
  maxRetries: 3,
  baseRetryDelayMs: 1000,
  log: new JsonlTransactionLog("/var/data/txqueue.jsonl"),
  onThrottle: ({ txId, estimatedWaitMs }) => {
    logger.info(`Throttled ${txId}, waiting ${estimatedWaitMs}ms`);
  },
  onSubmit: ({ txId, commandId, jsonSizeBytes, budgetUtilization }) => {
    logger.info(`Submitted ${txId} (${commandId}), ` +
      `JSON: ${jsonSizeBytes ?? "?"}B, budget: ${(budgetUtilization * 100).toFixed(0)}%`);
  },
  onDeadLetter: (record) => {
    logger.error(`Dead-lettered ${record.id}: ${record.error}`);
    // Alert, write to error table, etc.
  },
});
```

### Parameter Tuning

**`avgTxSizeBytes`** — Start with 7000 (7KB) as a baseline for typical Daml exercise commands. Run a batch with `onSubmit` logging `jsonSizeBytes`, then set this to the observed average. Overestimating is safer (slower throughput) than underestimating (risk of rejection).

**`safetyMargin`** — Start with 0.1 (10%). Increase to 0.15–0.2 if your participant runs multiple apps or you see occasional sequencer rejections despite the queue.

**`spreadPeriodMs`** — Defaults to `windowMs` (20 minutes). Set shorter to front-load submissions within each window, or longer to spread more conservatively. Setting it to `windowMs × 2` effectively halves your throughput but doubles your safety buffer.

**`maxRetries`** — 3 is a good default. Set higher for critical operations (e.g. token verification), lower for best-effort work.

**`baseRetryDelayMs`** — 1000ms is conservative. For latency-sensitive work, try 500ms. The exponential backoff caps at 30 seconds regardless.

---

## Integration Pattern

### 7Trust VerifyService Example

The VerifyService processes ~1,750 domain ownership tokens in a batch. Without the queue, this would submit them all as fast as the network allows — potentially overwhelming the traffic budget.

```typescript
// Create queue for this verification run
const queue = new TransactionQueue({
  ledger,
  budgetBytes: 200_000,
  windowMs: 1_200_000,
  safetyMargin: 0.15,
  mode: "time-spread",
  avgTxSizeBytes: 7000,
  log: new JsonlTransactionLog(config.trafficQueue.logFilePath),
  onDeadLetter: (record) => {
    logger.error(`Verification dead-lettered`, { txId: record.id, tag: record.tag });
  },
});

for (const [contractId, payload] of contracts.entries()) {
  if (!needsVerification(payload)) continue;

  const commands = buildVerifyCommands(contractId, payload, featuredAppRight);

  // Queue handles throttling, retries, and logging
  await queue.enqueueCommands(commands, undefined, {
    tag: `verify:${payload.domain}`,
  });
}

// Wait for all queued transactions to complete
await queue.close();

// Post-run diagnostics
const snapshot = await queue.getSnapshot();
logger.info(`Verification complete`, {
  total: snapshot.transactions.length,
  completed: snapshot.transactions.filter(t => t.state === "completed").length,
  deadLettered: snapshot.transactions.filter(t => t.state === "dead_lettered").length,
  budgetUtilization: snapshot.budget.utilization.toFixed(2),
});
```

### Pattern: One Queue Per Batch

Create a fresh queue for each batch operation. This keeps the transaction log scoped to a single run, making diagnostics and recovery simpler. The `close()` call at the end ensures all work is done before the batch reports results.

### Pattern: Long-Lived Queue

For services that submit transactions continuously (not in batches), create the queue at startup and keep it running:

```typescript
// At startup
const queue = new TransactionQueue({ ledger, ... });

// On each event
async function handleEvent(event: SomeEvent) {
  await queue.enqueueCommands(buildCommands(event), undefined, {
    tag: `event:${event.type}`,
  });
}

// On shutdown
process.on("SIGTERM", async () => {
  await queue.close();
  process.exit(0);
});
```

---

## Troubleshooting

### "Transaction rejected by sequencer"

You're exceeding the base rate budget. Possible causes:

1. **Budget parameters are wrong** — Query `AmuletRules` via Scan API for the live `burstAmount`. The mainnet value (200KB) differs from the documented default (400KB).
2. **Safety margin too low** — Background traffic (ACS commitments, topology txns) is eating into your budget. Increase `safetyMargin` to 0.15–0.2.
3. **Other apps on the same participant** — The budget is per-participant, shared across all parties and apps. The queue can only manage its own submissions.

### "Queue drains too slowly"

The time-spread delay is `spreadPeriodMs / (effectiveBudget / avgTxSizeBytes)`. If your transactions are smaller than `avgTxSizeBytes`, you're over-throttling.

Fix: Run a batch with `onSubmit` logging `jsonSizeBytes`, then lower `avgTxSizeBytes` to match reality.

### "Queue drains too fast, hitting rejections"

Your `avgTxSizeBytes` is too low (submitting more transactions than the budget allows), or `safetyMargin` doesn't account for background traffic.

Fix: Increase `avgTxSizeBytes` and/or `safetyMargin`.

### "Dead-lettered transactions"

Check the `onDeadLetter` callback or read the JSONL log:

```typescript
const log = new JsonlTransactionLog("/var/data/txqueue.jsonl");
const dead = await log.getByState("dead_lettered");
for (const record of dead) {
  console.log(`${record.id}: ${record.error} (${record.retryCount} retries, tag: ${record.tag})`);
}
```

Common causes:
- Non-transient errors (4xx) — the command itself is invalid
- Max retries exhausted on transient errors — the ledger was down too long
- Oversized transaction — the estimated cost exceeds the effective budget

### "Transactions stuck after server crash"

Read the JSONL log on restart:

```typescript
const log = new JsonlTransactionLog("/var/data/txqueue.jsonl");
const submitting = await log.getByState("submitting");
```

For each stuck transaction, use the `commandId` to check Canton's completions stream. If the command completed, the transaction landed. If not, re-submit — Canton will deduplicate by `commandId`.

### "close() hangs forever"

This means something is preventing the queue from fully draining. Check:
1. Is a transaction stuck in retry backoff with a very long delay?
2. Is the ledger down, causing all submissions to fail and retry?
3. In size-aware mode, is the head item larger than the effective budget? (This is now caught and dead-lettered automatically.)

Use `abort()` as an escape hatch if `close()` hangs too long:

```typescript
const timeout = setTimeout(() => {
  const aborted = queue.abort();
  logger.error(`Queue close timed out, aborted ${aborted.length} transactions`);
}, 60_000);

await queue.close();
clearTimeout(timeout);
```

---

## Known Limitations

1. **No actual traffic cost feedback** — We don't yet read `paid_traffic_cost` from Canton completions to recalibrate the budget tracker. The `actualCost` field on `TransactionRecord` is reserved for this.

2. **Size-aware drain loop not implemented** — `PrepareSubmission` is available on the `Ledger` class, but the queue's size-aware mode doesn't use it yet. Time-spread mode is the only operational mode.

3. **Per-participant, not per-party** — The traffic budget is shared across all parties on a participant. The queue manages its own submissions but can't account for other apps.

4. **No background traffic measurement** — We use `safetyMargin` as a static buffer for ACS commitments and topology transactions. A future improvement could measure actual background traffic to dynamically adjust.

5. **JSONL log grows unbounded** — The append-only log doesn't compact. For long-running queues, implement periodic log rotation or truncation of completed entries.

6. **JSON size ≠ protobuf traffic cost** — `estimateCommandsJsonSize()` is a rough proxy. The actual protobuf envelope is typically smaller. For exact numbers, use `prepareSubmission()`.

---

## File Map

| File | Purpose |
|------|---------|
| `src/queue.ts` | `TransactionQueue` class, `estimateCommandsJsonSize()` |
| `src/budget-tracker.ts` | `BudgetTracker` — linear recovery model |
| `src/transaction-log.ts` | `TransactionLog` interface, `InMemoryTransactionLog`, `JsonlTransactionLog` |
| `src/queue.test.ts` | Basic unit tests (11 tests) |
| `src/queue-battle.test.ts` | Battle tests — concurrency, shutdown, retry, stress (54 tests) |
| `src/budget-tracker.test.ts` | Budget recovery math tests (14 tests) |
| `src/transaction-log.test.ts` | Log persistence and recovery tests (12 tests) |
