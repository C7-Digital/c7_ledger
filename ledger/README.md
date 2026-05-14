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

This package ships against two cooperating but independently-versioned things:

- **Daml SDK runtime** (`@daml/types`): pinned at `3.4.11` — the compiler/types version shipped with splice 0.6.x.
- **JSON Ledger API spec** (selected by the build flag and surfaced as `SDK_VERSION`): defaults to `3.5.1-snapshot.20260423.18760.0` — the Canton 3.5.x runtime vendored inside splice 0.6.1, which is what DevNet/TestNet/MainNet actually serve.

Two spec files are checked in to cover both runtimes you might point this client at:

| File | Source | When to use |
|---|---|---|
| `specs/openapi_3.5.1-snapshot.20260423.18760.0.yaml` (default) | Canton 3.5.x via splice 0.6.1 | Talking to a splice 0.6.x participant (DevNet/TestNet/MainNet) |
| `specs/openapi_3.4.11.yaml` | Canton 3.4.11 via `dpm sandbox` | Local dev against the dpm-bundled sandbox (Canton 3.4.x line) |

To switch, override the build flag: `pnpm build -- --sdk-version=3.4.11`.

> Why two? `dpm` bundles `canton-enterprise-<daml-sdk-version>.jar`, so Daml SDK 3.4.11 ⇒ Canton 3.4.11. Splice 0.6.x decouples this: it uses Daml SDK 3.4.11 for compilation but pins Canton 3.5.x as the runtime. Canton 3.5.x adds 5 paths (notably `streamContinuationToken` on ACS streaming) that Canton 3.4.x doesn't expose.

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

The package uses the JSON Ledger API specification served by Canton, vendored as `specs/openapi_<canton-version>.yaml` and `specs/asyncapi_<canton-version>.yaml`. The version encodes the Canton runtime release.

To update or add a spec:

1. Get the spec from the canton runtime your target environment uses. Two paths:
   - **From splice** (Canton 3.5.x line): at any splice 0.6.x tag, the canton specs live under `canton/community/ledger/ledger-json-api/src/test/resources/json-api-docs/{openapi,asyncapi}.yaml`. Copy them into `ledger/specs/` renamed to `{openapi,asyncapi}_<canton-snapshot-version>.yaml`.
   - **From a live participant** (any Canton version): curl `http://<participant>:<json-api-port>/docs/openapi` and `/docs/asyncapi`. For local dev with `dpm sandbox`, that's `http://localhost:7575/docs/{openapi,asyncapi}`.
2. Update the build script's `--sdk-version=<version>` flag (the flag name is historical — it actually selects the spec file).
3. Run `pnpm build` to regenerate types.
