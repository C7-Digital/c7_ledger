# @c7-digital/ledger

OpenAPI v2 compatible Daml ledger client (that could replace `@daml/ledger`) for the new Canton JSON API v2.

## Overview

This package provides a TypeScript client for interacting with Canton's JSON Ledger API v2, which replaces the deprecated v1 API that `@daml/ledger` targets.

## Features

- **Type-safe API**: Generated TypeScript types from OpenAPI specification
- **OpenAPI v2 Support**: Targets the new Canton JSON API v2 endpoints
- **Auto-generated Types**: Uses `openapi-typescript` to generate accurate type definitions

## Versioning

This package follows the Canton SDK versioning scheme. The package version matches the Canton OpenAPI specification version used to generate the types.

**Current version**: `3.4.9`

- Corresponds to Canton SDK version `3.4.9`
- Types are generated from the OpenAPI spec for this specific Canton version
- When Canton releases a new version, this package will be updated to match

**Version compatibility**: Use the package version that matches your Canton participant node version for best compatibility.

## Installation

```bash
pnpm install @c7-digital/ledger
```

Or build from source:

```bash
pnpm install
pnpm build
```

## Usage

```typescript
import { Ledger } from "@c7-digital/ledger";

const ledger = new Ledger({
  token: "your-jwt-token",
  httpBaseUrl: "http://localhost:7575",
});

// Query contracts
const contracts = await ledger.query(MyTemplate);

// Create contracts
const result = await ledger.create(MyTemplate, payload, [actAsParty]);

// Exercise choices
const choiceResult = await ledger.exercise(MyChoice, contractId, argument, [actAsParty]);
```

## TransactionQueue (CIP-104 Traffic Management)

Canton's CIP-104 base rate imposes a traffic budget per participant (200KB per 20 minutes on mainnet as of 2026-04-04). Exceeding it rejects transactions; extra traffic costs $60/MB. The `TransactionQueue` throttles submissions to stay within the free budget.

### Basic Usage — Time-Spread Mode

```typescript
import { Ledger, TransactionQueue, exerciseCmd } from "@c7-digital/ledger";

const ledger = new Ledger({ token, httpBaseUrl: "http://localhost:7575" });

const queue = new TransactionQueue({
  ledger,
  budgetBytes: 200_000,       // Query AmuletRules for live value
  windowMs: 20 * 60 * 1000,   // 20 minutes
  safetyMargin: 0.15,          // 15% buffer for background traffic
  mode: "time-spread",
  avgTxSizeBytes: 7000,        // ~7KB per transaction
});

// Enqueue transactions — they execute when budget allows
for (const token of tokens) {
  const commands = [exerciseCmd(token.cid, MyTemplate.Verify, {})];
  await queue.enqueueCommands(commands);
}

// Wait for all queued transactions to complete
await queue.close();
```

### Persistent Transaction Log

Use `JsonlTransactionLog` so queued transactions survive server restarts. Each state transition is appended to a JSONL file. On restart, read the log to find transactions that were in-flight when the server crashed.

```typescript
import { TransactionQueue, JsonlTransactionLog } from "@c7-digital/ledger";

const queue = new TransactionQueue({
  ledger,
  budgetBytes: 200_000,
  windowMs: 1_200_000,
  mode: "time-spread",
  log: new JsonlTransactionLog("/var/data/txqueue.jsonl"),
  onDeadLetter: (record) => {
    console.error(`Transaction ${record.id} permanently failed: ${record.error}`);
  },
});
```

#### Recovery After Crash

```typescript
import { JsonlTransactionLog } from "@c7-digital/ledger";

const log = new JsonlTransactionLog("/var/data/txqueue.jsonl");

// Find transactions that were mid-submission when the server crashed
const stuck = await log.getByState("submitting");
for (const record of stuck) {
  // Canton deduplicates by commandId — safe to re-submit
  console.log(`Recovering tx ${record.id} (commandId: ${record.commandId})`);
  // Re-enqueue or verify via completions stream
}
```

### Priority and Callbacks

```typescript
const queue = new TransactionQueue({
  ledger,
  budgetBytes: 200_000,
  windowMs: 1_200_000,
  mode: "time-spread",
  maxRetries: 3,
  baseRetryDelayMs: 1000,
  onThrottle: ({ txId, estimatedWaitMs }) => {
    console.log(`Throttled ${txId}, waiting ${estimatedWaitMs}ms`);
  },
  onSubmit: ({ txId, budgetUtilization }) => {
    console.log(`Submitted ${txId}, budget at ${(budgetUtilization * 100).toFixed(0)}%`);
  },
  onDeadLetter: (record) => {
    console.error(`Dead-lettered ${record.id} after ${record.retryCount} retries`);
  },
});

// High-priority transactions execute first
await queue.enqueue(() => ledger.submit(urgentCommands), { priority: 10 });
await queue.enqueue(() => ledger.submit(normalCommands), { priority: 0 });
```

### Monitoring and Health Checks

```typescript
// Snapshot of queue state
const snapshot = await queue.getSnapshot();
console.log({
  depth: snapshot.depth,
  budgetUtilization: snapshot.budget.utilization,
  bytesRemaining: snapshot.budget.balance,
  paused: snapshot.paused,
  completed: snapshot.transactions.filter(t => t.state === "completed").length,
  deadLettered: snapshot.transactions.filter(t => t.state === "dead_lettered").length,
});

// Pause/resume (e.g. during maintenance)
queue.pause();
queue.resume();

// Emergency abort — rejects all pending, returns their records
const aborted = queue.abort();
console.log(`Aborted ${aborted.length} pending transactions`);
```

### Traffic Cost Estimation (PrepareSubmission)

The `Ledger` class exposes `prepareSubmission()` for estimating transaction traffic cost without committing. This is the foundation for the queue's future size-aware mode.

```typescript
const response = await ledger.prepareSubmission(commands, actAs);

if (response.costEstimation) {
  console.log(`Estimated traffic: ${response.costEstimation.totalTrafficCostEstimation} bytes`);
  console.log(`  Confirmation request: ${response.costEstimation.confirmationRequestTrafficCostEstimation} bytes`);
  console.log(`  Confirmation response: ${response.costEstimation.confirmationResponseTrafficCostEstimation} bytes`);
}
```

### Troubleshooting

**Transactions rejected by sequencer** — You're exceeding the base rate budget. Enable the queue with your participant's actual `burstAmount` (query `AmuletRules` via Scan API — don't trust the docs, mainnet may differ).

**Queue drains too slowly** — Lower `avgTxSizeBytes` if your transactions are smaller than the default 7KB. The time-spread delay is `spreadPeriodMs / (effectiveBudget / avgTxSizeBytes)` — overestimating tx size means fewer transactions per window.

**Queue drains too fast and hits rejections** — Increase `safetyMargin` (default 0.1). Other apps or background traffic (ACS commitments, topology transactions) on the same participant share the budget.

**Dead-lettered transactions** — Check the `onDeadLetter` callback and the transaction log. The `commandId` on each record can be used to query Canton's completions stream to check if the transaction actually landed despite the client-side error.

**Recovery after crash** — Read the JSONL log with `JsonlTransactionLog`. Transactions in `"submitting"` state may or may not have landed. Use the `commandId` to check completions. Canton deduplicates by `(userId, actAs, commandId)`, so re-submitting a completed command is safe.

**Budget parameters changed** — SVs can vote to change `burstAmount` and `burstWindow`. Query `AmuletRules` periodically and update the queue's budget tracker via `queue.getBudget()`.

## Migration from @daml/ledger

Key differences:

- `create()` and `exercise()` methods now require an `actAs` parameter
- Some method signatures have been updated to match OpenAPI v2 spec
- New type definitions generated from OpenAPI specification

## Development

```bash
# Build the package
pnpm build

# Clean build artifacts
pnpm clean

# Watch for changes
pnpm watch

# Run tests
pnpm test

# Lint code
pnpm lint
```

## OpenAPI Specification

The package uses the OpenAPI specification from Canton 3.4.9. The spec is saved as a version specific file (e.x. `openapi_3.4.9.yaml`) and types are automatically generated into `src/generated/api.ts`.

To update the specification:

1. Download from docs.digitalasset.com or from your participant node.
2. Update the build script to use the new SDK version
3. Run `pnpm build` to regenerate types
