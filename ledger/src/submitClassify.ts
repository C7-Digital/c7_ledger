// Submit-outcome classification across transport and Canton payload.
//
// These read Canton's *structured* answer — `LedgerApiError`'s HTTP status and
// `cantonError`'s `code` / `errorCategory` — never the rendered message. A
// substring match on `${code}: ${cause}` is fragile: it false-positives on prose
// in a nested cause and breaks when a code id is reworded. The structured fields
// do not have that problem, so callers ask what happened instead of grepping it.
//
// Scope is generic and reusable. Any app that submits to the ledger — and any
// app that archives (an idempotent delete) — composes these; the *policy* of
// what to do with the answer (stop as success, wait, back off) stays with the
// caller.

import { cantonErrorOf, categoryOf, isRetryable } from "./cantonError";
import { LedgerApiError } from "./error";

// Canton codes that make an archive (or any idempotent delete) a no-op success:
//   DUPLICATE_COMMAND                — the command already committed
//   CONTRACT_NOT_FOUND               — the contract is already gone
//   LOCAL_VERDICT_INACTIVE_CONTRACTS — the contract is already inactive
//
// Matched by `code`, not `errorCategory`: category 11 (`resourceMissing`) also
// covers `UNSUPPORTED_CONTRACT_ID`, which is a hard failure, not a no-op — so a
// category check would be too broad here.
const ALREADY_ARCHIVED_CODES: ReadonlySet<string> = new Set([
  "DUPLICATE_COMMAND",
  "CONTRACT_NOT_FOUND",
  "LOCAL_VERDICT_INACTIVE_CONTRACTS",
]);

/**
 * The contract this archive targets is already gone, or the archive command
 * already committed — so an archive (or idempotent delete) can treat the reject
 * as success. Whether "already gone = success" holds is the caller's operation:
 * true for an archive, false for an exercise that needs the contract live. This
 * reports the fact; the caller applies that judgement.
 */
export function isAlreadyArchived(error: unknown): boolean {
  const canton = cantonErrorOf(error);
  return canton !== null && ALREADY_ARCHIVED_CODES.has(canton.code);
}

/**
 * Worth retrying: a transport transient (`LedgerApiError.isTransient` — 408 /
 * 429 / 5xx) or a Canton-retryable rejection (`isRetryable`, keyed off
 * `errorCategory`: contention, transient, deadline, seek-after-end).
 *
 * Check {@link isIndeterminateSubmit} first: an indeterminate failure is also
 * retriable, but only with the same `commandId`.
 */
export function isRetriableSubmit(error: unknown): boolean {
  if (error instanceof LedgerApiError && error.isTransient()) return true;
  const canton = cantonErrorOf(error);
  return canton !== null && isRetryable(canton);
}

/**
 * Submit outcome unknown — retry only with the *same* `commandId`, after a wait,
 * so command deduplication guards against a double apply. HTTP 503 (the request
 * may have committed under an abandoned attempt) or a Canton `deadline`
 * (category 3, whose own definition is "may or may not have been applied").
 */
export function isIndeterminateSubmit(error: unknown): boolean {
  if (error instanceof LedgerApiError && error.isIndeterminate()) return true;
  const canton = cantonErrorOf(error);
  return canton !== null && categoryOf(canton) === "deadline";
}
