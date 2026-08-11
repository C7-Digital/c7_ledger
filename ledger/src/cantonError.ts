// Reading a Canton rejection using the classification Canton already sent.
//
// Every error the ledger returns carries an `errorCategory: number` — a
// required field on {@link JsCantonError}, not an optional hint. Upstream it is
// a closed, numbered enum
// (`canton/base/errors/.../error/ErrorCategory.scala`) where each case fixes a
// gRPC status, a log level, and — decisively — whether Canton itself considers
// the failure worth retrying.
//
// Consumers have been re-deriving a lossy fragment of that enum from the
// `code` string:
//
//     if (code === "LOCAL_VERDICT_LOCKED_CONTRACTS" ||
//         code === "CONTRACT_STATE_CHANGED" ||
//         code === "INCONSISTENT_CONTRACT_KEY") { /* contention: retry */ }
//
// That allow-list is a hand-maintained guess at a taxonomy the payload already
// states as an integer: all three codes are `errorCategory: 2`
// (`ContentionOnSharedResources`), along with every other contention code
// Canton has now or adds later. This module exposes the enum instead, so a
// caller asks Canton what happened rather than pattern-matching its prose.
//
// Scope is deliberately narrow. This is *interpretation* of a payload, not
// *extraction* of one from a transport envelope, and not *presentation* of one
// to a user:
//
//   - Extraction is transport-specific. The direct JSON-API path is handled
//     here ({@link cantonErrorOf} reads `LedgerApiError.cantonError`); a
//     CIP-0103 wallet gateway wraps the same payload in its own JSON-RPC
//     envelopes, and peeling those belongs in whatever owns that transport.
//     {@link cantonErrorOf} is structural precisely so such a decoder can
//     expose a `cantonError` property and be understood here with no
//     dependency in either direction.
//   - Presentation is product voice. Whether an application shows one sentence
//     for categories 6 and 7 or two different ones is its call, not the
//     library's. This module reports what Canton said, completely; it renders
//     nothing.
//
// No new record type is introduced for the result. {@link JsCantonError} is
// generated from Canton's own AsyncAPI schema and already carries every field
// worth reading; a parallel struct would be the same data described twice, and
// the second description is the one that drifts. What is added here are
// accessors over that type.

import { isCantonError, type JsCantonError } from "./types";

/**
 * Canton's `ErrorCategory`, named.
 *
 * The integers are `ErrorCategory.asInt` upstream and are part of the wire
 * contract — they appear verbatim as `errorCategory` on every rejection. The
 * names here are the upstream case-object names, lower-cased; they are not a
 * reinterpretation, so a reader can grep either side and land in the same
 * place.
 *
 * Note `security` covers two upstream cases (`SecurityAlert` and
 * `UnredactedSecurityAlert`) because both are `asInt = 5` — they differ only in
 * whether details are redacted before transmission, which is a server-side
 * decision already applied by the time we see the payload.
 */
export type CantonErrorCategory =
  | "transient" //        1  TransientServerFailure
  | "contention" //       2  ContentionOnSharedResources
  | "deadline" //         3  DeadlineExceededRequestStateUnknown
  | "internal" //         4  SystemInternalAssumptionViolated
  | "security" //         5  SecurityAlert / UnredactedSecurityAlert
  | "unauthenticated" //  6  AuthInterceptorInvalidAuthenticationCredentials
  | "permission" //       7  InsufficientPermission
  | "invalidRequest" //   8  InvalidIndependentOfSystemState
  | "invalidState" //     9  InvalidGivenCurrentSystemStateOther
  | "resourceExists" //  10  InvalidGivenCurrentSystemStateResourceExists
  | "resourceMissing" // 11  InvalidGivenCurrentSystemStateResourceMissing
  | "seekAfterEnd" //    12  InvalidGivenCurrentSystemStateSeekAfterEnd
  | "degraded" //        13  BackgroundProcessDegradationWarning
  | "unsupported"; //    14  InternalUnsupportedOperation

/**
 * `errorCategory` → name. Sparse-safe: an integer outside 1..14 means a Canton
 * newer than this build, which {@link categoryOf} reports as `null` rather than
 * guessing.
 */
const CATEGORY_BY_INT: Readonly<Record<number, CantonErrorCategory>> = {
  1: "transient",
  2: "contention",
  3: "deadline",
  4: "internal",
  5: "security",
  6: "unauthenticated",
  7: "permission",
  8: "invalidRequest",
  9: "invalidState",
  10: "resourceExists",
  11: "resourceMissing",
  12: "seekAfterEnd",
  13: "degraded",
  14: "unsupported",
};

/**
 * The categories whose upstream definition carries `retryable = Some(...)`.
 *
 * Transcribed from `ErrorCategory.scala` rather than reasoned about: `deadline`
 * is retryable there even though the request's outcome is *unknown*, which is
 * not what most readers would assume. See {@link isRetryable} for why that
 * distinction still matters to a caller.
 */
const RETRYABLE_CATEGORIES: ReadonlySet<CantonErrorCategory> = new Set<CantonErrorCategory>([
  "transient",
  "contention",
  "deadline",
  "seekAfterEnd",
]);

/**
 * Canton's `ErrorResource` type tags, as they appear in the first slot of each
 * `resources` pair.
 *
 * Transcribed from `ErrorResource.all` upstream. Enumerating them is the point:
 * it makes {@link resourcesOf} a checked lookup instead of a string the caller
 * has to get right from memory.
 *
 * Any tag may arrive prefixed `NULLABLE_` (`ErrorResource.nullable`), meaning
 * the resource is known to the error but may legitimately be absent.
 * {@link resourcesOf} matches with or without that prefix.
 */
export type CantonResourceKind =
  | "COMMAND_ID"
  | "CONTRACT_ARG"
  | "CONTRACT_ID"
  | "CONTRACT_IDS"
  | "CONTRACT_KEY"
  | "CONTRACT_KEY_HASH"
  | "CRYPTO_VALUE"
  | "DEV_ERROR_TYPE"
  | "EXCEPTION_TEXT"
  | "EXCEPTION_TYPE"
  | "EXCEPTION_VALUE"
  | "EXPECTED_TYPE"
  | "EXTERNAL_CALL_EXTENSION_ID"
  | "EXTERNAL_CALL_FUNCTION_ID"
  | "FIELD_INDEX"
  | "IDENTITY_PROVIDER_CONFIG"
  | "INTERFACE_ID"
  | "OFFSET"
  | "PACKAGE"
  | "PACKAGE_NAME"
  | "PARTIES"
  | "PARTY"
  | "SYNCHRONIZER_ALIAS"
  | "SYNCHRONIZER_ID"
  | "TEMPLATE_ID"
  | "TRANSACTION_HASH"
  | "TRANSACTION_ID"
  | "UPDATE_ID"
  | "USER";

/**
 * Which category Canton assigned, or `null` when the payload names a category
 * this build does not know.
 *
 * `null` is not a failure mode to paper over — it is the honest answer for a
 * participant running a newer Canton, and it keeps a caller's `switch` from
 * silently mis-filing a case that did not exist when this was written.
 */
export function categoryOf(e: JsCantonError): CantonErrorCategory | null {
  return CATEGORY_BY_INT[e.errorCategory] ?? null;
}

/**
 * Whether Canton's own category definition marks this failure retryable.
 *
 * Prefer this to any local judgement about a `code`: it is the same table the
 * participant, the sequencer, and the Ledger API clients use.
 *
 * One caveat the flag alone does not convey: `deadline` (category 3) is
 * retryable, but its meaning is *"the request may or may not have been
 * applied"*. A caller retrying a category-3 write needs command deduplication;
 * a caller retrying a category-2 (`contention`) write does not, because
 * contention means the transaction definitively did not commit. Check
 * {@link categoryOf} when that distinction matters.
 *
 * An unknown category is reported as not retryable — the conservative reading,
 * since retrying an unrecognised failure risks amplifying it.
 */
export function isRetryable(e: JsCantonError): boolean {
  if (typeof e.retryInfo === "string" && e.retryInfo.trim() !== "") return true;
  const category = categoryOf(e);
  return category !== null && RETRYABLE_CATEGORIES.has(category);
}

/**
 * The values Canton attached for one resource kind, in the order it listed
 * them.
 *
 * Canton populates `resources` deliberately — `ContentionOnSharedResources`
 * documents that *"if the resource is known (i.e. locked contract), it will be
 * included as a resource info"* — so this is where a contract id or party lives
 * as data. Reading it beats scraping the `cause` sentence for a hex run: the
 * sentence is prose Canton is free to reword, and the pairs are not.
 *
 * Returns `[]` when the kind is absent, so a caller can iterate without a
 * presence check.
 */
export function resourcesOf(
  e: JsCantonError,
  kind: CantonResourceKind
): readonly string[] {
  const resources = e.resources;
  if (!Array.isArray(resources)) return [];
  const nullable = `NULLABLE_${kind}`;
  return resources
    .filter(
      (pair): pair is [string, string] =>
        Array.isArray(pair) &&
        pair.length === 2 &&
        (pair[0] === kind || pair[0] === nullable) &&
        typeof pair[1] === "string"
    )
    .map((pair) => pair[1]);
}

/**
 * Find the Canton payload inside a thrown value, or `null` if there is none.
 *
 * Three shapes resolve, and the property probe is what makes the third work:
 *
 *   1. A {@link JsCantonError} handed over directly.
 *   2. A `LedgerApiError` from this package — its `cantonError` property.
 *   3. Anything else exposing a `cantonError` property that satisfies
 *      {@link isCantonError}. This is the seam for a wallet-gateway decoder:
 *      it peels its own envelopes, publishes the payload under that name, and
 *      is understood here without this package importing it or it importing
 *      this one.
 *
 * Structural rather than `instanceof` for a second reason: `instanceof` fails
 * across duplicated copies of a package in a pnpm tree, which is exactly the
 * situation a monorepo with several apps produces.
 *
 * Envelope walking is deliberately *not* done here. A value that needs
 * unwrapping has not reached the layer that knows how it was wrapped.
 */
export function cantonErrorOf(e: unknown): JsCantonError | null {
  if (isCantonError(e)) return e;
  if (e !== null && typeof e === "object" && "cantonError" in e) {
    const nested = (e as { cantonError: unknown }).cantonError;
    if (isCantonError(nested)) return nested;
  }
  return null;
}
