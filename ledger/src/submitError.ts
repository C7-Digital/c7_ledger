// Classifying a failed JSON Ledger API *submit* for the caller that has to
// decide: retry, wait-and-dedup, treat as already done, or stop.
//
// {@link cantonErrorOf} / {@link isRetryable} already tell you what Canton said
// when a structured rejection arrived. That is not enough for every transport
// outcome the JSON API produces:
//
//   - A request that times out at the HTTP layer (~20s) returns 503 *without*
//     cancelling the in-flight command. The client sees failure while Canton
//     may still hold activeness locks; a fresh `commandId` then contends with
//     the abandoned submit. That is {@link SubmitErrorKind} `"indeterminate"`,
//     not a plain transient — callers must wait and reuse the same command id.
//   - Some rejects mean the write already happened (`DUPLICATE_COMMAND`) or the
//     contract is already gone (`CONTRACT_NOT_FOUND` / inactive). Those are
//     success for idempotent ops (archive, migrate), not reasons to retry.
//
// This module folds Canton payload + HTTP status + message heuristics into one
// closed sum so each consumer does not re-derive the same regex table.

import { cantonErrorOf, categoryOf, isRetryable } from "./cantonError";
import { LedgerApiError } from "./error";

/**
 * What a failed JSON Ledger API submit means for retry / idempotency.
 *
 * Prefer this over matching `error.message` in application code. The kinds are
 * mutually exclusive; {@link classifySubmitError} picks exactly one.
 */
export type SubmitErrorKind =
  /** Prior submit with the same command id was accepted. */
  | "alreadyApplied"
  /** Contract is inactive / not found — gone for idempotent archive-style ops. */
  | "alreadyGone"
  /**
   * Outcome unknown: the HTTP request timed out (typically 503) while the
   * command may still be in flight. Wait out the participant timeout, reuse
   * the same `commandId`, then retry or confirm via ACS.
   */
  | "indeterminate"
  /** Safe to retry (Canton retryable, locked contracts, 408/429/5xx). */
  | "transient"
  /** Definitive failure — do not retry. */
  | "hard";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** HTTP status when `error` is a {@link LedgerApiError} (or a structural twin). */
function httpStatusOf(error: unknown): number | undefined {
  if (error instanceof LedgerApiError) return error.status;
  // Structural: survives a duplicated copy of this package in a pnpm tree
  // where `instanceof` would fail.
  if (
    error !== null &&
    typeof error === "object" &&
    "name" in error &&
    (error as { name: unknown }).name === "LedgerApiError" &&
    "status" in error &&
    typeof (error as { status: unknown }).status === "number"
  ) {
    return (error as { status: number }).status;
  }
  return undefined;
}

function codeMentions(error: unknown, pattern: RegExp): boolean {
  const canton = cantonErrorOf(error);
  if (canton && pattern.test(canton.code)) return true;
  return pattern.test(errorMessage(error));
}

/**
 * JSON API request timed out; the submission may still be in flight holding
 * locks. Prefer waiting (~participant request timeout) and reusing `commandId`
 * over treating this as a normal backoff retry.
 */
export function isIndeterminateSubmitTimeout(error: unknown): boolean {
  if (httpStatusOf(error) === 503) return true;
  const message = errorMessage(error);
  return /\bHTTP 503\b/i.test(message) || /timely response/i.test(message);
}

/** `DUPLICATE_COMMAND` — the same command id already committed. */
export function isSubmitAlreadyApplied(error: unknown): boolean {
  return codeMentions(error, /DUPLICATE_COMMAND/i);
}

/**
 * Contract already absent: `CONTRACT_NOT_FOUND`, inactive-contracts verdicts,
 * or Canton's `resourceMissing` category.
 */
export function isSubmitAlreadyGone(error: unknown): boolean {
  const canton = cantonErrorOf(error);
  if (canton) {
    if (categoryOf(canton) === "resourceMissing") return true;
    if (/CONTRACT_NOT_FOUND|INACTIVE_CONTRACTS/i.test(canton.code)) return true;
  }
  return /CONTRACT_NOT_FOUND|INACTIVE_CONTRACTS/i.test(errorMessage(error));
}

/** Activeness lock contention (`LOCAL_VERDICT_LOCKED_CONTRACTS` and kin). */
export function isLockedContractsError(error: unknown): boolean {
  return codeMentions(error, /LOCKED_CONTRACTS/i);
}

/**
 * Classify a thrown submit failure.
 *
 * Order is intentional: already-done outcomes win over retry signals (so a
 * `DUPLICATE_COMMAND` is never reported as transient), and indeterminate 503
 * wins over a generic 5xx transient reading.
 */
export function classifySubmitError(error: unknown): SubmitErrorKind {
  if (isSubmitAlreadyApplied(error)) return "alreadyApplied";
  if (isSubmitAlreadyGone(error)) return "alreadyGone";
  if (isIndeterminateSubmitTimeout(error)) return "indeterminate";

  const canton = cantonErrorOf(error);
  if (canton) {
    if (isRetryable(canton)) return "transient";
    // Contention that is not already-gone (handled above). Locked contracts
    // are category 2 / retryable in Canton; keep an explicit locked check for
    // payloads that only surface the code in the message.
    if (isLockedContractsError(error)) return "transient";
  } else if (isLockedContractsError(error)) {
    return "transient";
  }

  const status = httpStatusOf(error);
  if (status === 408 || status === 429 || (status !== undefined && status >= 500 && status < 600)) {
    return "transient";
  }

  const message = errorMessage(error);
  if (/\bHTTP 408\b/i.test(message) || /\bHTTP 429\b/i.test(message)) {
    return "transient";
  }
  if (/\bHTTP 5\d\d\b/i.test(message)) {
    return "transient";
  }

  return "hard";
}

/**
 * True when the caller should retry the submit (possibly after an
 * indeterminate wait). Already-applied / already-gone are false — those are
 * success at the call site for idempotent writes.
 */
export function isTransientSubmitError(error: unknown): boolean {
  const kind = classifySubmitError(error);
  return kind === "transient" || kind === "indeterminate";
}
