---
name: submit-error-classification
description: >-
  Decide whether JSON Ledger API submit failure handling belongs in
  @c7-digital/ledger (c7_ledger) or in a consumer app. Use when adding retry
  logic, classifying 503/409/DUPLICATE/LOCKED errors, moving regex tables out
  of domain-verification, or extending classifySubmitError / cantonError.
---

# Submit error classification

Goal: **one closed sum** for failed JSON Ledger API submits in `@c7-digital/ledger`. Consumer apps keep domain policy only (budgets, stable command ids, ACS checks).

## When this applies

- A consumer matches `error.message` for `HTTP 503`, `DUPLICATE_COMMAND`, `LOCKED_CONTRACTS`, `INACTIVE_CONTRACTS`, etc.
- Adding retry/backoff around `ledger.submit` / `ledger.exercise`
- Leo-style review: "generic JSON API result error handling belongs in c7-ledger"
- Extending Canton error vocabulary or submit classification in c7_ledger

## Layer map

| Layer | Module | Owns |
|-------|--------|------|
| Transport read | `ledger/src/error.ts` | HTTP status, tagged body, `LedgerApiError.message` summary |
| Canton payload | `ledger/src/cantonError.ts` | `errorCategory`, `isRetryable`, `resourcesOf`, `cantonErrorOf` |
| Submit outcome | `ledger/src/submitError.ts` | `classifySubmitError` → `SubmitErrorKind` |

**Do not** add a fourth copy in apps.

## SubmitErrorKind (closed sum)

| Kind | Typical signal | Consumer action |
|------|----------------|-----------------|
| `alreadyApplied` | `DUPLICATE_COMMAND` | Idempotent success |
| `alreadyGone` | `CONTRACT_NOT_FOUND`, inactive, `resourceMissing` | Idempotent success (archive-style) |
| `indeterminate` | HTTP 503 / timely-response timeout | Wait (~participant request timeout), **reuse same commandId**, then retry or ACS-check |
| `transient` | Canton retryable, `LOCKED_CONTRACTS`, 408/429/5xx | Backoff retry (same or stable commandId per policy) |
| `hard` | Bare 409, 4xx client errors | Fail — do not retry |

## Checklist — add to c7_ledger (not the app)

```
Submit error in c7_ledger when:
- [ ] Classification is transport- or Canton-generic (any submit caller would need it)
- [ ] It combines HTTP status + Canton payload + message heuristics
- [ ] Multiple consumers already duplicate the same regex / status checks
- [ ] New export added to ledger/src/index.ts AND api-surface.test.ts
- [ ] Unit tests in ledger/src/submitError.test.ts (and cantonError.test.ts if Canton-only)
- [ ] ledger/README.md Errors section updated if public API changes
```

## Checklist — keep in consumer app

```
Stay in the app when:
- [ ] Domain command id scheme (e.g. dir-mig-archive-{contractId})
- [ ] Wall-clock retry budget shared across batch + fallback
- [ ] ACS `isStillActive` / beforeRetry hooks
- [ ] Batch size, logging context, product-specific idempotency sequencing
- [ ] Calling classifySubmitError and switching on the kind — thin wrapper only
```

## Example — consumer thin wrapper

```typescript
import {
  classifySubmitError,
  ARCHIVE_ALREADY_COMPLETE, // app sentinel if needed
} from "@c7-digital/ledger";

try {
  await ledger.submit(commands, actAs, commandId);
} catch (e) {
  switch (classifySubmitError(e)) {
    case "alreadyApplied":
    case "alreadyGone":
      return; // success
    case "indeterminate":
      await sleep(INDETERMINATE_WAIT_MS);
      if (!(await isStillActive(cid))) return;
      return retrySameCommandId();
    case "transient":
      return withBackoff(() => ledger.submit(..., commandId));
    case "hard":
      throw e;
  }
}
```

## Adding a new classifier to ledger

1. Implement in `ledger/src/submitError.ts` (or `cantonError.ts` if pure Canton, no HTTP).
2. Export from `ledger/src/index.ts`.
3. Add to `api-surface.test.ts` export list.
4. Tests with real-shaped `LedgerApiError` bodies and plain `Error` message fallbacks.
5. Release ledger; bump consumer pin.

## Anti-patterns

- String-matching `LOCAL_VERDICT_*` in apps when `cantonErrorOf` + `categoryOf` suffice.
- Treating all HTTP 409 as transient (INACTIVE/DUPLICATE are success).
- Immediate retry after 503 with a **new** commandId (self-contention → LOCKED).
- Putting archive migrate budgets or Postgres logic in c7_ledger.

## References

- [ledger/README.md — Errors](../../../ledger/README.md)
- [ledger/AGENTS.md](../../../ledger/AGENTS.md)
- domain-verification reference consumer: `apps/api/src/db/directoryArchiveRetry.ts` (to be thinned onto ledger helpers)
