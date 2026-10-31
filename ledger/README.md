# @c7-digital/ledger

OpenAPI v2 compatible Daml ledger client (that could replace `@daml/ledger`) for the new Canton JSON API v2.

## Overview

This package provides a TypeScript client for interacting with Canton's JSON Ledger API v2, which replaces the deprecated v1 API that `@daml/ledger` targets.

## Features

- **Type-safe API**: Generated TypeScript types from OpenAPI specification
- **OpenAPI v2 Support**: Targets the new Canton JSON API v2 endpoints
- **Auto-generated Types**: Uses `openapi-typescript` to generate accurate type definitions

## Versioning

The npm package has its own `0.0.x` version line, independent of the Canton spec it targets. Pre-1.0, every release is a patch bump; a breaking change also gets a `Migrating to 0.0.N` note below. The Canton runtime and JSON API spec this client is built against are versioned separately and surfaced as `SDK_VERSION` (see below), not as the package version.

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

// Read whole transactions (update id, record time, exercised choices) a page
// at a time; the participant can cut a page short, so loop on reachedOffset.
const participantId = await ledger.getParticipantId();
const end = await ledger.getLedgerEnd();
let offset = 0;
while (offset < end) {
  const page = await ledger.getTransactionPage(
    { beginExclusive: offset, endInclusive: end },
    { parties: [party] },
  );
  for (const tx of page.transactions) console.log(tx.updateId, tx.recordTime);
  offset = page.reachedOffset;
}
```

## Service-account tokens

A server that acts on the ledger as a service account imports
`@c7-digital/ledger/service-account`. It gets tokens through the OAuth 2.0
client-credentials grant from any OpenID Connect issuer, and it keeps the token
valid. This entry point is separate from the main one for two reasons: only a
server can keep a client secret, and it needs the optional peer dependency
`openid-client` (`pnpm add openid-client`).

```typescript
import { Ledger } from "@c7-digital/ledger";
import {
  ClientCredentialsTokenSource,
  TokenRefresher,
} from "@c7-digital/ledger/service-account";

const source = new ClientCredentialsTokenSource({
  issuer: new URL("https://auth.example.com/realms/my-realm"),
  clientId: "my-service",
  clientSecret: process.env.CLIENT_SECRET!,
  audience: "https://ledger.example.com", // only if the issuer needs it
});

let ledger: Ledger | null = null;
const refresher = new TokenRefresher({
  source,
  onToken: ({ token }) => ledger?.setToken(token),
  onFailure: ({ error, failures, retryInMs }) =>
    console.warn("token refresh failed", { error, failures, retryInMs }),
});

const { token } = await refresher.start(); // throws if the first token fails
ledger = new Ledger({ token, httpBaseUrl: "https://participant.example.com" });
```

- `TokenRefresher` refreshes at 80 % of the token lifetime. After a failure it
  retries with backoff (5 s, doubled each time, at most 60 s) until a refresh
  succeeds. A stream that holds its own token must also be updated in
  `onToken`.
- `refreshNow()` gets a new token at once, for example after the ledger rejects
  the current token. Calls during a refresh join that refresh.
- `status()` gives the last refresh, the next refresh, the token expiry, the
  last error and the number of failures, for a health page.
- `stop()` stops the refresh.
- `ClientCredentialsTokenSource` finds the token endpoint through the issuer's
  `.well-known/openid-configuration`. It refuses http unless
  `allowInsecureHttp` is set; set it only for a local issuer.
- Any other `TokenSource` (an object with `mint()`) works with
  `TokenRefresher` too.

## Errors

A non-OK HTTP response throws a `LedgerApiError` carrying the status and the
response body, tagged with how that body was read:

```typescript
export type LedgerErrorBody =
  | { kind: "canton"; error: JsCantonError }  // a rejection Canton can explain
  | { kind: "json"; value: unknown }          // some other structured error
  | { kind: "text"; text: string }            // a proxy's HTML page, a plain message
  | { kind: "empty" };                        // no body, or unreadable
```

The tag records a decision made once, when the body is read, so a caller does
not re-derive it from `typeof` — which cannot tell a JSON string literal from
an HTML error page.

`cantonError` and `responseBody` are derived from `body`, so they cannot
disagree with it. Use `cantonErrorOf` to reach the Canton payload; it also
resolves a bare payload and a wallet-gateway wrapper, so one call covers every
path a rejection can arrive by.

```typescript
try {
  await ledger.exercise(MyChoice, cid, arg, [party]);
} catch (e) {
  const canton = cantonErrorOf(e);
  if (canton && isRetryable(canton)) return retry();
  if (e instanceof LedgerApiError && e.body.kind === "text") {
    // Markup here means a proxy answered, not the ledger.
  }
}
```

For submit retry / idempotency, read Canton's *structured* classification (the
`errorCategory` integer and the exact `code`), never the rendered message. Three
helpers over `unknown` compose the transport (`LedgerApiError`) and Canton
(`cantonError`) signals so callers don't re-derive them:

- **Should I retry at all?** `isRetriableSubmit(e)` — a transport transient
  (408 / 429 / 5xx) or a Canton-retryable rejection (`errorCategory` ∈
  contention / transient / deadline / seek-after-end).
- **Must I keep the same `commandId`?** `isIndeterminateSubmit(e)` — HTTP 503 or a
  Canton `deadline` (category 3). The submit may already have committed, so retry
  with the **same** `commandId` after a wait. A plain transient (429) is safe to
  retry fresh. Check this **before** `isRetriableSubmit`.
- **Did my resubmit hit dedup?** `isAlreadyApplied(e)` — `DUPLICATE_COMMAND`: a
  retry with the *same* `commandId` found the participant already applied the
  prior (seemingly-lost) attempt. A caller retrying an indeterminate submit with a
  stable `commandId` treats this as success.
- **Is my archive already a no-op?** `isAlreadyArchived(e)` — `isAlreadyApplied`
  **or** the contract is already gone (`CONTRACT_NOT_FOUND`,
  `LOCAL_VERDICT_INACTIVE_CONTRACTS`). Reusable by any app that archives; the
  *policy* of treating it as success stays with the caller.
- **Confirmed permanent hard fail?** `isConfirmedPermanentReject(e)` — structured
  Canton rejection that Canton marks non-retryable, and not already-archived.
  Bare HTTP 4xx / plain Errors are **false** (fail closed for ignore-and-proceed).

Each takes `unknown` and reads the status structurally (`httpStatusOf`, also
exported), so they work directly on a `catch` binding — no `instanceof` needed,
and they survive duplicated package copies in a pnpm tree.

```typescript
try {
  await ledger.exercise(Archive, cid, arg, [party]);
} catch (e) {
  if (isAlreadyArchived(e)) return; // idempotent: already gone
  if (isIndeterminateSubmit(e)) return retrySameCommandId();
  if (isRetriableSubmit(e)) return retry();
  if (isConfirmedPermanentReject(e)) return markIgnored(); // domain policy
  throw e;
}
```

`message` carries a summary of the body bounded to 120 characters, so logging
it cannot emit a whole error page. The full value stays on `body`.

### Migrating to 0.0.45

Adds the entry point `@c7-digital/ledger/service-account` (see
[Service-account tokens](#service-account-tokens)): `TokenRefresher`,
`ClientCredentialsTokenSource`, `retryDelayMs`, and the types `TokenSource`,
`MintedToken`, `RefreshFailure`, `TokenRefresherStatus`,
`TokenRefresherOptions` and `ClientCredentialsOptions`. `openid-client` is a
new optional peer dependency, needed only for this entry point. Additive;
nothing removed.

### Migrating to 0.0.43

Exports the request-body builders that `Ledger.query` and
`Ledger.queryInterface` use. Use them when the request goes over another
transport, for example a CIP-0103 wallet's `ledgerApi` proxy, so the body has
the same shape as the one `Ledger` sends. Additive; nothing removed.

- `activeContractsRequest(parties, filters, activeAtOffset, verbose?)` builds
  the `POST /v2/state/active-contracts` body. The party filter is in
  `eventFormat`. Canton 3.6 participants reject the deprecated top-level
  `filter` by default (`DEPRECATED_API_DISABLED`).
- `templateFilter(templateId, includeCreatedEventBlob?)` and
  `interfaceFilter(interfaceId, includeCreatedEventBlob?)` build the
  `IdentifierFilter`s. The interface filter always asks for the interface view.
- The types `IdentifierFilter` and `GetActiveContractsRequest` are exported.

```typescript
import { activeContractsRequest, templateFilter } from "@c7-digital/ledger/lite";

const body = activeContractsRequest([party], [templateFilter(Token.templateId)], offset);
```

### Migrating to 0.0.42

Adds update-history and participant reads. Additive; nothing removed.

- `Ledger.getTransactionPage(range, { parties, shape, limit })` returns whole
  transactions in `(beginExclusive, endInclusive]` (default shape: ledger
  effects, so exercised choices are present) and the `reachedOffset` to resume
  from.
- `Ledger.getParticipantId()` and `TypedHttpClient.getParticipantId()` read
  `GET /v2/parties/participant-id`.
- `TypedHttpClient.getUpdates(request, { limit })` sends `POST /v2/updates`.
- `Ledger.getLedgerEnd()` is now public (it was private); it keeps the
  one-second cache.

### Migrating to 0.0.41

A query at `"end"` now sees the same `Ledger` instance's own writes. A
successful `create`, `exercise`, `exerciseResult`, `submit` or
`submitWithDisclosures` moves the cached ledger end forward to the
transaction's offset. Before, the one-second ledger-end cache could serve an
offset from before the write, so the query could still return contracts that
the write had archived. No API change.

### Migrating to 0.0.40

Adds `isConfirmedPermanentReject(e)` — structured Canton non-retryable reject,
excluding already-archived no-ops. Bare transport 4xx / plain Errors stay
`false` so ignore-and-proceed callers fail closed. Additive; nothing removed.

### Migrating to 0.0.39

Adds `isAlreadyApplied(e)` — `DUPLICATE_COMMAND` alone (the command already
committed), for callers that retry an indeterminate submit with a stable
`commandId` and must treat a dedup hit as success. `isAlreadyArchived` now
composes it (`isAlreadyApplied` or contract-gone) — same behavior, no change for
its callers. Additive; nothing removed.

### Migrating to 0.0.38

Adds structured, reusable submit classifiers so consumers stop hand-rolling them:
`isRetriableSubmit`, `isIndeterminateSubmit`, and `isAlreadyArchived` (see above),
plus `httpStatusOf` for reading a status structurally. All read `cantonError`'s
`code` / `errorCategory` and the HTTP status — no message-string matching.

The short-lived `LedgerApiError.isTransient()` / `.isIndeterminate()` methods
(0.0.37) are **removed** in favour of these free functions: a method forces an
`instanceof` check at the call site, which fails across duplicated package copies
and is the exact anti-pattern the free functions avoid.

```typescript
// 0.0.37
if (e instanceof LedgerApiError && e.isIndeterminate()) retrySameCommandId();
// 0.0.38
if (isIndeterminateSubmit(e)) retrySameCommandId();
```

### Migrating to 0.0.37

The `submitError` helpers (`isArchiveAlreadyDoneError`,
`isIndeterminateArchiveTimeout`, `isIndeterminateSubmitError`,
`isLockedContractsError`, `isTransientArchiveError`) are removed. They duplicated
`cantonError` — read Canton's classification instead:

```typescript
// before
if (isTransientArchiveError(e)) retry();
if (isIndeterminateSubmitError(e)) retrySameCommandId();

// after (0.0.38 free functions)
if (isIndeterminateSubmit(e)) retrySameCommandId();
else if (isRetriableSubmit(e)) retry();
```

Whether a missing or inactive contract counts as success is caller policy —
`isAlreadyArchived(e)` reports the fact; the caller decides to stop as success.

### Migrating to 0.0.34

The `LedgerApiError` constructor takes a tagged `LedgerErrorBody` instead of an
untagged `unknown`. Reading an error is unchanged — `status`, `statusText`,
`cantonError`, and `responseBody` all behave as before. Only code that
*constructs* one, which in practice means tests and mocks, needs updating:

```typescript
new LedgerApiError(404, "Not Found", cantonPayload)      // before
new LedgerApiError(404, "Not Found", { kind: "canton", error: cantonPayload })

new LedgerApiError(403, "Forbidden", "<html>…</html>")   // before
new LedgerApiError(403, "Forbidden", { kind: "text", text: "<html>…</html>" })
```

The two-argument form still means "no body" and needs no change.

`ScanApiError` in `@c7-digital/scan` has the same `status`, `statusText`,
`body`, and `responseBody`, so a `catch` that can receive either reads one set
of fields. It has no `canton` case.

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
