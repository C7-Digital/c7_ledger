// Shared helper for extracting a choice's decoded return value out of a
// `TRANSACTION_SHAPE_LEDGER_EFFECTS` response.
//
// Callers submit the exercise with `transactionShape = LEDGER_EFFECTS`
// (see {@link Ledger.exerciseResult}), then hand this helper the resulting
// event list — either from the participant's `submitAndWaitForTransaction`
// response or from a downstream `POST /v2/updates/update-by-id` fetch (the
// path a wallet-mode dApp takes because CIP-0103's
// `prepare_execute_and_wait` returns only `{updateId, completionOffset}`).
//
// Both transports produce the same `components["schemas"]["Event"][]` shape
// — an ArchivedEvent / CreatedEvent / ExercisedEvent variant — so the walk
// factors cleanly out of `Ledger.exerciseResult` and is reused verbatim by
// `@c7-private/dapp-stack`'s `ExternalPartySession.exerciseResult`.

import type { Choice, ContractId } from "@daml/types";
import type { components } from "./generated/api";

/**
 * Locate the root `ExercisedEvent` matching `(choice, contractId)` in
 * `events`, and decode its `exerciseResult` via `choice.resultDecoder`.
 *
 * `events` MUST come from a submission or update-fetch made with
 * `TRANSACTION_SHAPE_LEDGER_EFFECTS`; the default `ACS_DELTA` shape drops
 * `ExercisedEvent`s (they're not create/archive events) and this helper
 * will then throw a "no matching ExercisedEvent" error.
 *
 * "Root exercise" = the choice we submitted. Match by `(choice.choiceName,
 * contractId)` so a future change that surfaces child exercises (a Daml
 * choice that internally exercises another choice) doesn't pick up the
 * wrong result.
 *
 * @throws if the LEDGER_EFFECTS response contains no matching
 *         `ExercisedEvent`, or the matching event has no `exerciseResult`.
 *         Both indicate the transport returned an unexpected shape.
 */
export function decodeExerciseResult<T extends object, C, R, K = unknown>(
  events: readonly components["schemas"]["Event"][],
  choice: Choice<T, C, R, K>,
  contractId: ContractId<T>
): R {
  const contractIdStr = contractId.toString();
  for (const event of events) {
    if ("ExercisedEvent" in event) {
      const ee = event.ExercisedEvent;
      if (
        ee.choice === choice.choiceName &&
        ee.contractId === contractIdStr
      ) {
        if (ee.exerciseResult === undefined) {
          throw new Error(
            `exerciseResult: LEDGER_EFFECTS response for ` +
              `${choice.template().templateId}::${choice.choiceName} ` +
              `has no exerciseResult — the server returned an unexpected shape.`
          );
        }
        return choice.resultDecoder.runWithException(ee.exerciseResult);
      }
    }
  }
  throw new Error(
    `exerciseResult: no matching ExercisedEvent for ` +
      `${choice.template().templateId}::${choice.choiceName} ` +
      `on contract ${contractIdStr}. The submission may have used a ` +
      `transaction shape that does not include exercise nodes.`
  );
}
