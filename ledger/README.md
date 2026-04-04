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

Canton's CIP-104 base rate imposes a traffic budget per participant (200KB per 20 minutes on mainnet). Exceeding it rejects transactions; extra traffic costs $60/MB. The `TransactionQueue` throttles submissions to stay within the free budget, with automatic retries, priority ordering, and crash-recoverable transaction logging.

```typescript
import { Ledger, TransactionQueue, JsonlTransactionLog, exerciseCmd } from "@c7-digital/ledger";

const ledger = new Ledger({ token, httpBaseUrl: "http://localhost:7575" });

const queue = new TransactionQueue({
  ledger,
  budgetBytes: 200_000,       // Query AmuletRules for live value
  windowMs: 20 * 60 * 1000,   // 20 minutes
  safetyMargin: 0.15,          // 15% buffer for background traffic
  mode: "time-spread",
  avgTxSizeBytes: 7000,        // ~7KB per transaction
  log: new JsonlTransactionLog("/var/data/txqueue.jsonl"),
});

// Enqueue transactions — they execute when budget allows
for (const token of tokens) {
  await queue.enqueueCommands(
    [exerciseCmd(token.cid, MyTemplate.Verify, {})],
    undefined,
    { tag: `verify:${token.domain}` },
  );
}

await queue.close(); // Wait for all to complete
```

For the full design rationale, budget model, retry semantics, recovery procedures, configuration guide, and troubleshooting, see **[QUEUEING.md](QUEUEING.md)**.

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
