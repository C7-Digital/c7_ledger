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

// An earlier submit of this same change id (user id, command id, actAs) is still
// being processed by the participant. The change id is those three fields only; a
// later submission id does not make a new change, so a fresh retry attempt of the
// same command can still meet the in-flight original. Canton files this under
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

// The sequencer refuses a submission when the submitting node has no traffic
// credit left.
const OUT_OF_TRAFFIC_CODE = "SEQUENCER_NOT_ENOUGH_TRAFFIC_CREDIT";
// The participant wraps a failed send to the sequencer in this code.
const SEQUENCER_REQUEST_FAILED_CODE = "SEQUENCER_REQUEST_FAILED";
// The inner code id as a whole token, so a longer code that contains it does
// not match.
const OUT_OF_TRAFFIC_TOKEN = new RegExp(`(^|[^A-Z0-9_])${OUT_OF_TRAFFIC_CODE}([^A-Z0-9_]|$)`);

/**
 * The submitting node has no traffic credit: the sequencer refused the
 * submission (`SEQUENCER_NOT_ENOUGH_TRAFFIC_CREDIT`, `AboveTrafficLimit`). The
 * answer is definite (`definiteAnswer = true`), and a retry cannot succeed
 * until the node buys traffic. A retry spends more of the traffic that the
 * node gets back over time, so the caller must stop.
 *
 * The participant gives this to a submitter as `SEQUENCER_REQUEST_FAILED`
 * (category `contention`, which is retryable) and puts the inner sequencer
 * error only in `context.sendError`, as rendered text. Canton gives the inner
 * code in no structured field. So this check reads that one context field and
 * matches the inner code id as a whole token. This is the only place where a
 * classifier reads rendered text; every other check reads `code` or
 * `errorCategory`. A top-level `SEQUENCER_NOT_ENOUGH_TRAFFIC_CREDIT` code also
 * matches.
 */
export function isOutOfTraffic(error: unknown): boolean {
  const canton = cantonErrorOf(error);
  if (canton === null) return false;
  if (canton.code === OUT_OF_TRAFFIC_CODE) return true;
  if (canton.code !== SEQUENCER_REQUEST_FAILED_CODE) return false;
  const sendError: unknown = (canton.context as Record<string, unknown>)["sendError"];
  return typeof sendError === "string" && OUT_OF_TRAFFIC_TOKEN.test(sendError);
}

/**
 * Worth retrying: a transport transient (408 / 429 / 5xx, read via
 * `httpStatusOf`) or a Canton-retryable rejection (`isRetryable`, keyed off
 * `errorCategory`: contention, transient, deadline, seek-after-end). A node
 * with no traffic credit ({@link isOutOfTraffic}) is never worth retrying,
 * although Canton files it under `contention`.
 *
 * Check {@link isIndeterminateSubmit} first: an indeterminate failure is also
 * retriable, but only with the same `commandId`.
 */
export function isRetriableSubmit(error: unknown): boolean {
  if (isOutOfTraffic(error)) return false;
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
  // A refusal for lack of traffic is definite, whatever the HTTP status.
  if (isOutOfTraffic(error)) return false;
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
 * are success for idempotent deletes, not permanent rejects. Includes
 * {@link isOutOfTraffic}: Canton files it as retryable, but the answer is
 * definite and no retry can succeed until the node buys traffic.
 *
 * `!isRetriableSubmit` alone is not enough — that is also true for transport
 * 4xx with no Canton payload. Compose this fact into domain policy (e.g. mark
 * ignored and continue cutover); do not re-derive it in the consumer.
 */
export function isConfirmedPermanentReject(error: unknown): boolean {
  // Definite, and no retry can succeed until the node buys traffic.
  if (isOutOfTraffic(error)) return true;
  if (isAlreadyArchived(error) || isRetriableSubmit(error)) {
    return false;
  }
  const canton = cantonErrorOf(error);
  return canton !== null && !isRetryable(canton);
}
