// JSON Ledger API submit failure classification for retry and command dedup.
//
// Builds on `cantonError.ts` (Canton payload vocabulary) with transport-level
// HTTP/message heuristics. Does not replace or modify cantonError — consumers
// still use cantonErrorOf / isRetryable for raw Canton interpretation.
//
// Core classification consolidated from consumer-app submit-retry logic.
// `isIndeterminateSubmitError` is additive: covers HTTP 503 timeouts and Canton
// `deadline` (category 3), both of which may have committed under an abandoned
// submit and therefore require wait + same commandId before retry.

import { cantonErrorOf, categoryOf, isRetryable } from "./cantonError";
import { LedgerApiError } from "./error";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Prior submit committed, or contract already gone — treat as archive success. */
export function isArchiveAlreadyDoneError(error: unknown): boolean {
  const message = errorMessage(error);
  return (
    /DUPLICATE_COMMAND/i.test(message) ||
    /CONTRACT_NOT_FOUND/i.test(message) ||
    /INACTIVE_CONTRACTS/i.test(message)
  );
}

/** JSON API timed out; submission may still be in flight holding locks. */
export function isIndeterminateArchiveTimeout(error: unknown): boolean {
  if (error instanceof LedgerApiError && error.status === 503) {
    return true;
  }
  const message = errorMessage(error);
  return /\bHTTP 503\b/i.test(message) || /timely response/i.test(message);
}

/**
 * Submit outcome unknown — retry only with the same `commandId` after a wait.
 *
 * Covers {@link isIndeterminateArchiveTimeout} (JSON API ~20s request timeout)
 * and Canton `deadline` / `DeadlineExceededRequestStateUnknown` (category 3).
 * {@link isRetryable} marks deadline retryable, but cantonError.ts documents
 * that the write may already have been applied; callers must not treat it as a
 * plain backoff transient.
 */
export function isIndeterminateSubmitError(error: unknown): boolean {
  if (isIndeterminateArchiveTimeout(error)) {
    return true;
  }
  const canton = cantonErrorOf(error);
  return canton !== null && categoryOf(canton) === "deadline";
}

export function isLockedContractsError(error: unknown): boolean {
  return /LOCKED_CONTRACTS/i.test(errorMessage(error));
}

/** True when archive submit should be retried (locks, overload, Canton retryable). */
export function isTransientArchiveError(error: unknown): boolean {
  // Already-complete rejects are success at the call site — never "retry".
  if (isArchiveAlreadyDoneError(error)) {
    return false;
  }

  const canton = cantonErrorOf(error);
  if (canton) {
    // Indeterminate (503, deadline) — retriable, but callers must use
    // isIndeterminateSubmitError for wait + commandId dedup, not plain backoff.
    if (isIndeterminateSubmitError(error)) {
      return true;
    }
    if (isRetryable(canton)) {
      return true;
    }
    // Contention (LOCKED_CONTRACTS) — but not INACTIVE (handled above).
    if (categoryOf(canton) === "contention" && isLockedContractsError(error)) {
      return true;
    }
  }

  if (isLockedContractsError(error)) {
    return true;
  }

  if (isIndeterminateArchiveTimeout(error)) {
    return true;
  }

  if (error instanceof LedgerApiError) {
    const status = error.status;
    if (status === 408 || status === 429 || (status >= 500 && status < 600)) {
      return true;
    }
    // Do not treat bare HTTP 409 as transient — INACTIVE/DUPLICATE are success;
    // unknown 409s without LOCKED are hard failures.
  }

  const message = errorMessage(error);
  if (/\bHTTP 408\b/i.test(message) || /\bHTTP 429\b/i.test(message)) {
    return true;
  }
  if (/\bHTTP 5\d\d\b/i.test(message)) {
    return true;
  }
  return false;
}
