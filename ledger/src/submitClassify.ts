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
import { httpStatusOf } from "./error";

// Canton codes that make an archive (or any idempotent delete) a no-op success:
//   DUPLICATE_COMMAND                — the command already committed
//   CONTRACT_NOT_FOUND               — the contract is already gone
//   LOCAL_VERDICT_INACTIVE_CONTRACTS — the contract is already inactive
//
// Matched by `code`, not `errorCategory`: category 11 (`resourceMissing`) also
// covers `UNSUPPORTED_CONTRACT_ID`, which is a hard failure, not a no-op — so a
// category check would be too broad here.
//
// The contract is already gone (as opposed to the command already having been
// applied — see isAlreadyApplied):
const CONTRACT_GONE_CODES: ReadonlySet<string> = new Set([
  "CONTRACT_NOT_FOUND",
  "LOCAL_VERDICT_INACTIVE_CONTRACTS",
]);

// An earlier submit of this same change id (user id, command id, actAs, submission
// id) is still being processed by the participant. Canton files this under
// `ContentionOnSharedResources` (category 2) but marks it `definiteAnswer = false`:
// the outcome is NOT yet known, so it is the one contention code that is
// indeterminate rather than "definitely did not commit" (see isSubmissionInFlight).
const SUBMISSION_IN_FLIGHT_CODE = "SUBMISSION_ALREADY_IN_FLIGHT";

/**
 * The command already committed — a resubmit with the *same* `commandId` hit the
 * participant's command deduplication (`DUPLICATE_COMMAND`). A caller retrying an
 * indeterminate submit (see {@link isIndeterminateSubmit}) with a stable
 * `commandId` treats this as success: the prior, seemingly-lost attempt applied.
 * Reports the fact; the caller decides to stop as success.
 */
export function isAlreadyApplied(error: unknown): boolean {
  return cantonErrorOf(error)?.code === "DUPLICATE_COMMAND";
}

/**
 * The archive this targets is already the case — the command already committed
 * ({@link isAlreadyApplied}) or the contract is already gone — so an archive (or
 * idempotent delete) can treat the reject as success. Whether "already gone =
 * success" holds is the caller's operation: true for an archive, false for an
 * exercise that needs the contract live. Reports the fact; the caller applies it.
 */
export function isAlreadyArchived(error: unknown): boolean {
  if (isAlreadyApplied(error)) return true;
  const canton = cantonErrorOf(error);
  return canton !== null && CONTRACT_GONE_CODES.has(canton.code);
}

/**
 * Worth retrying: a transport transient (408 / 429 / 5xx, read via
 * `httpStatusOf`) or a Canton-retryable rejection (`isRetryable`, keyed off
 * `errorCategory`: contention, transient, deadline, seek-after-end).
 *
 * Check {@link isIndeterminateSubmit} first: an indeterminate failure is also
 * retriable, but only with the same `commandId`.
 */
export function isRetriableSubmit(error: unknown): boolean {
  // Transport transient: 408, 429, or any 5xx (503 included — see
  // isIndeterminateSubmit for the same-commandId caveat).
  const status = httpStatusOf(error);
  if (status === 408 || status === 429 || (status !== undefined && status >= 500)) {
    return true;
  }
  const canton = cantonErrorOf(error);
  return canton !== null && isRetryable(canton);
}

/**
 * An earlier submit of this exact change id is still in flight at the
 * participant — Canton `SUBMISSION_ALREADY_IN_FLIGHT`. Its outcome is not yet
 * known (`definiteAnswer = false`), so this is *not* "the transaction did not
 * commit": the command may still commit, fail, or already have done either.
 *
 * Canton's own resolution for this code is: listen to the command completion
 * stream for this command id until a completion is published, rather than
 * resubmit — a resubmit while the original is still in flight just returns this
 * same reject. A resubmit resolves it only once the original has cleared (then
 * `DUPLICATE_COMMAND` {@link isAlreadyApplied} if it committed, or a fresh
 * attempt if it failed). So a caller settling an indeterminate submit should
 * *wait for the completion* on this fact, not count another resubmit attempt.
 *
 * Structural, keyed on `code` (like {@link isAlreadyApplied}): the category
 * integer cannot carry this, because the code shares category 2 with
 * `LOCAL_VERDICT_LOCKED_CONTRACTS`, which *did* definitively not commit.
 */
export function isSubmissionInFlight(error: unknown): boolean {
  return cantonErrorOf(error)?.code === SUBMISSION_IN_FLIGHT_CODE;
}

/**
 * Submit outcome unknown — retry only with the *same* `commandId`, after a wait,
 * so command deduplication guards against a double apply. Three shapes:
 *
 *   - HTTP 503 — the request may have committed under an abandoned attempt;
 *   - a Canton `deadline` (category 3, whose own definition is "may or may not
 *     have been applied");
 *   - {@link isSubmissionInFlight} — the same change id is still in flight, so
 *     its outcome is pending (`definiteAnswer = false`).
 *
 * All three keep the same `commandId`. They differ in how to wait: 503 /
 * `deadline` resubmit under dedup, whereas an in-flight command should be
 * resolved by awaiting its completion (a resubmit only bounces until it clears
 * — see {@link isSubmissionInFlight}). The caller owns that policy; this states
 * that the outcome is not yet determinate.
 */
export function isIndeterminateSubmit(error: unknown): boolean {
  if (httpStatusOf(error) === 503) return true;
  if (isSubmissionInFlight(error)) return true;
  const canton = cantonErrorOf(error);
  return canton !== null && categoryOf(canton) === "deadline";
}

/**
 * Structured Canton rejection that Canton itself marks non-retryable
 * (permission, invalid request/state, etc.) — a confirmed permanent hard fail.
 *
 * Requires a Canton payload (`cantonErrorOf`); bare HTTP 4xx and plain client
 * Errors are **false** so ignore-and-proceed callers fail closed on unknowns.
 * Excludes {@link isAlreadyArchived} (already-applied / contract gone): those
 * are success for idempotent deletes, not permanent rejects.
 *
 * `!isRetriableSubmit` alone is not enough — that is also true for transport
 * 4xx with no Canton payload. Compose this fact into domain policy (e.g. mark
 * ignored and continue cutover); do not re-derive it in the consumer.
 */
export function isConfirmedPermanentReject(error: unknown): boolean {
  if (isAlreadyArchived(error) || isRetriableSubmit(error)) {
    return false;
  }
  const canton = cantonErrorOf(error);
  return canton !== null && !isRetryable(canton);
}
