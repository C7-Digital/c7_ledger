# @c7-digital/server

Server infrastructure for Canton Network applications. Provides the core services that every Canton API backend needs: contract streaming, Keycloak identity management, structured logging, and auth utilities.

## Installation

```bash
pnpm add @c7-digital/server
```

Peer dependency: `@c7-digital/ledger >= 0.0.8`

## Overview

| Export | Description |
|--------|-------------|
| `ActiveContractsService` | Streams and caches contracts from the Canton ledger via MultiStream |
| `TemplateTracker` | Per-template contract map with create/archive callbacks |
| `InterfaceTracker` | Per-interface view map with view/archive callbacks |
| `IdentityService` | Keycloak token lifecycle with auto-refresh and heartbeat monitoring |
| `Logger` / `LedgerLoggerAdapter` | Structured JSON logging to stdout/stderr |
| `@c7-digital/server/auth` | Isomorphic (browser + Node) auth payload encode/decode utilities |

## ActiveContractsService

Maintains an in-memory cache of active contracts by streaming updates from the Canton JSON API. Register templates and interfaces before initialization, then access their payloads through type-safe trackers.

```typescript
import {
  ActiveContractsService,
  TemplateTracker,
} from "@c7-digital/server";
import { lookupTemplate } from "@my-app/codegen";

const acs = new ActiveContractsService({
  ledgerUrl: "http://localhost:7575",
  versionedRegistry: lookupTemplate,
});

// Register templates before init
const tokenTracker = acs.registerTemplate(MyToken);

// Optionally register interfaces
const viewTracker = acs.registerInterface(MyInterface);

// Set up callbacks
tokenTracker.onContractCreated((contractId, payload, createEvent) => {
  console.log("New contract:", contractId);
});

tokenTracker.onContractArchived((contractId) => {
  console.log("Archived:", contractId);
});

// Initialize with a ledger token
await acs.initWithToken(token);

// Access cached contracts
const allContracts = acs.getAllPayloads(MyToken);
const single = acs.getPayload(MyToken, contractId);
const count = acs.getContractCount(MyToken);
```

### Constructor Options

```typescript
interface ActiveContractsServiceOptions {
  ledgerUrl?: string;              // Canton JSON API URL
  versionedRegistry: VersionedRegistry; // From scribe-generated codegen
  logger?: AcsLogger;              // Optional structured logger
}
```

### GC Safety

The service maintains strong references to all active streams via internal `Set` collections, preventing garbage collection. For streams created outside the main MultiStream, use `addStreamReference()` and `removeStreamReference()`.

### Custom Logger

Inject a logger matching the `AcsLogger` interface:

```typescript
interface AcsLogger {
  info(message: string, context?: Record<string, any>): void;
  warn(message: string, context?: Record<string, any>): void;
  error(message: string, error?: Error | Record<string, any>): void;
  debug(message: string, context?: Record<string, any>): void;
}
```

If no logger is provided, a no-op logger is used.

## IdentityService

Manages the Keycloak token lifecycle for service-to-service (client credentials) authentication. Handles initial token fetch, automatic refresh before expiry, retry with exponential backoff, and a heartbeat monitor that catches missed refreshes.

```typescript
import { IdentityService, Logger } from "@c7-digital/server";

const logger = new Logger();
const identity = new IdentityService(
  {
    url: "https://keycloak.example.com",
    realm: "canton",
    clientId: "my-api",
    clientSecret: "secret",
  },
  logger
);

// Register callbacks before init
identity.onTokenUpdate("acs", async (newToken) => {
  await acs.initWithToken(newToken);
});

// Initialize (fetches first token, starts refresh cycle)
await identity.init();

// Or use a static token for local development
await identity.initWithStaticToken(staticToken);

// Access token
const token = identity.getToken();
const status = identity.getStatus();

// Clean shutdown
await identity.destroy();
```

### Key Features

- **Auto-refresh**: Schedules token refresh at `min(expiresIn - 60s, expiresIn / 2)` before expiry
- **Heartbeat monitor**: 30-second interval that catches missed scheduled refreshes
- **Retry with backoff**: Up to 3 attempts with exponential backoff on token fetch failure
- **Static token mode**: `initWithStaticToken()` bypasses Keycloak for local/sandbox development
- **Token callbacks**: Register multiple services to be notified on token change via `onTokenUpdate()`

## Logger

Structured JSON logger that writes to stdout (all levels) and stderr (WARN/ERROR). Includes depth-limited object serialization to prevent oversized log entries.

```typescript
import { Logger, LedgerLoggerAdapter, limitObjectDepth } from "@c7-digital/server";

const logger = new Logger();

logger.info("Server started", { port: 3002 });
logger.error("Connection failed", new Error("timeout"), { url: "..." });

// Adapter for @c7-digital/ledger's Logger interface
const ledgerLogger = new LedgerLoggerAdapter(logger);

// Utility: limit nested object depth (default 6 levels)
const safe = limitObjectDepth(deeplyNestedObject);
```

### Log Format

```json
{
  "@timestamp": "2025-01-15T10:30:00.000Z",
  "level": "INFO",
  "message": "Server started",
  "port": 3002
}
```

## Auth Utilities

Isomorphic (browser + Node.js) utilities for encoding and decoding typed auth payloads as base64 Bearer tokens. Available via the `@c7-digital/server/auth` subpath export.

```typescript
import {
  encodeAuthPayload,
  decodeAuthPayload,
  createAdminAuth,
  createContractAuth,
  isAdminAuth,
  isContractAuth,
  getAuthPayloadFromRequest,
} from "@c7-digital/server/auth";

// Encode for use in Authorization header
const token = createAdminAuth("my-api-key");
// -> base64 of {"type":"admin","apiKey":"my-api-key"}

const contractToken = createContractAuth(contractId, party);
// -> base64 of {"type":"contract","contractId":"...","party":"..."}

// Decode from Authorization: Bearer <token>
const result = getAuthPayloadFromRequest(req);
if (result.success && isAdminAuth(result.data)) {
  // result.data.apiKey
}
```

### Payload Types

Two discriminated union variants:

| Type | Fields | Use Case |
|------|--------|----------|
| `AdminAuthPayload` | `type: "admin"`, `apiKey` | Admin API authentication |
| `ContractAuthPayload` | `type: "contract"`, `contractId`, `party` | Contract-scoped operations |

All payloads are validated at encode and decode time using Zod schemas.

## sha256

Simple hash utility used internally by IdentityService to redact secrets in logs.

```typescript
import { sha256 } from "@c7-digital/server";

const hash = sha256("my-secret"); // hex string
```

## Subpath Exports

| Import Path | Contents |
|-------------|----------|
| `@c7-digital/server` | All services, logger, sha256, ACS types |
| `@c7-digital/server/auth` | Auth encode/decode utilities (browser-safe, no Node.js deps) |

## Dependencies

- `@c7-digital/ledger` (peer) — Canton JSON API client
- `@daml/types` — Daml type system
- `keycloak-connect` — Keycloak token management
- `jose` — JWT decoding
- `zod` — Auth payload validation
