---
name: submit-error-classification
description: >-
  Decide whether JSON Ledger API submit failure handling belongs in
  @c7-digital/ledger (c7_ledger) or in a consumer app. Use when adding retry
  logic, classifying 503/409/DUPLICATE/LOCKED errors, moving classification
  out of a consumer app, or extending submitError.ts.
---

# Submit error classification

Goal: **one copy** of submit failure classification in `@c7-digital/ledger`. Consumer apps keep domain policy only (retry budgets, stable command ids, ACS liveness checks, the app's retry wrapper).

## When this applies

- A consumer duplicates `isTransientArchiveError` / regex tables for 503, DUPLICATE, LOCKED
- Adding retry/backoff around `ledger.submit` / `ledger.exercise`
- Review note: "generic JSON API result error handling belongs in c7-ledger"

## Ledger exports (`ledger/src/submitError.ts`)

The classifiers below were consolidated from consumer-app retry logic — **one canonical copy, same logic**:

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
- [ ] Behavior test lives beside the helper in this repo
- [ ] The consumer imports from @c7-digital/ledger instead of duplicating
```

## Checklist — stays in consumer app

```
- [ ] The app's retry wrapper, retry budgets, indeterminate-wait constant
- [ ] Stable command ids (per-contract / per-batch)
- [ ] ACS liveness check before retry
- [ ] Logging, batch size, product sequencing
```

## Anti-patterns

- Adding `classifySubmitError` / `SubmitErrorKind` when the four booleans suffice
- `resourceMissing` category or structural `httpStatusOf` beyond the canonical classifiers
- String-matching in apps when ledger exports the helper
- Immediate retry after 503 with a new commandId

## References

- [ledger/src/submitError.ts](../../../ledger/src/submitError.ts) — the classifiers
- [ledger/README.md — Errors](../../../ledger/README.md)
