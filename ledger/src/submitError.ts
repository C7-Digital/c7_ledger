// JSON Ledger API submit failure classification.
// Lifted verbatim from domain-verification `directoryArchiveRetry.ts`
// (isArchiveAlreadyDoneError through isTransientArchiveError).

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
