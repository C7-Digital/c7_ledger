---
name: submit-error-classification
description: >-
  Decide whether JSON Ledger API submit failure handling belongs in
  @c7-digital/ledger (c7_ledger) or in a consumer app. Use when adding retry
  logic, classifying 503/409/DUPLICATE/LOCKED errors, moving logic out of
  domain-verification, or extending submitError.ts.
---

# Submit error classification

Goal: **one copy** of submit failure classification in `@c7-digital/ledger`. Consumer apps keep domain policy only (budgets, stable command ids, ACS checks, `withArchiveRetry`).

## When this applies

- A consumer duplicates `isTransientArchiveError` / regex tables for 503, DUPLICATE, LOCKED
- Adding retry/backoff around `ledger.submit` / `ledger.exercise`
- Leo-style review: "generic JSON API result error handling belongs in c7-ledger"

## Ledger exports (`ledger/src/submitError.ts`)

Direct lift from domain-verification `directoryArchiveRetry.ts` — **same four functions, same logic**:

| Function | Purpose |
|----------|---------|
| `isArchiveAlreadyDoneError` | `DUPLICATE_COMMAND`, `CONTRACT_NOT_FOUND`, `INACTIVE_CONTRACTS` in message |
| `isIndeterminateArchiveTimeout` | HTTP 503 / timely-response timeout |
| `isIndeterminateSubmitError` | 503 **or** Canton `deadline` — wait + reuse `commandId` |
| `isLockedContractsError` | `LOCKED_CONTRACTS` in message |
| `isTransientArchiveError` | Retriable; use `isIndeterminateSubmitError` first for dedup vs backoff |

Supporting Canton vocabulary stays in `cantonError.ts` (`cantonErrorOf`, `categoryOf`, `isRetryable`).

## Checklist — belongs in c7_ledger

```
- [ ] Matches the helpers above (message-only already-done; not broad resourceMissing)
- [ ] New export in ledger/src/index.ts AND api-surface.test.ts
- [ ] Test copied/adapted from domain-verification directoryArchiveRetry.test.ts
- [ ] domain-verification imports from @c7-digital/ledger instead of duplicating
```

## Checklist — stays in consumer app

```
- [ ] withArchiveRetry, budgets, DEFAULT_INDETERMINATE_ARCHIVE_WAIT_MS
- [ ] Stable command ids (archiveCommandIdForContract/Batch)
- [ ] ACS isStillActive / beforeRetry
- [ ] Logging, batch size, product sequencing
```

## Anti-patterns

- Adding `classifySubmitError` / `SubmitErrorKind` when the four booleans suffice
- `resourceMissing` category or structural `httpStatusOf` not in domain-verification original
- String-matching in apps when ledger exports the helper
- Immediate retry after 503 with a new commandId

## References

- domain-verification source: `apps/api/src/db/directoryArchiveRetry.ts` (classification block)
- [ledger/README.md — Errors](../../../ledger/README.md)
