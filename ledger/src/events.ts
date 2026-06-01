// Helpers for poking at the `Event[]` returned by `Ledger.exercise` and
// `Ledger.submitWithDisclosures`. The ledger client's value-add over the
// raw JSON Ledger API is that it returns typed `CreateEvent<T>` /
// `ArchiveEvent<T>`; these helpers let consumers find a specific
// side-effect contract WITHOUT having to hand-roll a `typeof` /
// `templateId` regex guard at every call site.
//
// One guarantee the helpers preserve regardless of the wire's behaviour:
//
//   **Live-contract filtering.** A contract created and archived in the
//   same transaction (e.g. an intermediate holding inside an
//   `AmuletRules_Transfer`) shows up as both a `CreatedEvent` and an
//   `ArchivedEvent` with the same `contractId`. Lookup helpers skip
//   such transient creates so the caller only sees contracts that
//   survive the transaction.
//
// Input ordering is the LEDGER's contract: `Ledger.exercise` and
// `Ledger.submitWithDisclosures` return events already sorted by
// `nodeId` (see `sortEventsByNodeId` in `./ledger`). These helpers
// trust that order — they iterate the input as-is, so "first match"
// means "earliest in nodeId order" when consuming a ledger response.
//
// Match by template-id suffix, so the helpers work whether the wire
// shape is `<package-id-hash>:Module:Entity` (the JSON Ledger API) or
// `#package-name:Module:Entity` (the codegen constant the caller holds).

import type { Template } from "@daml/types";
import type { ArchiveEvent, CreateEvent, SortedEvents } from "./types.js";

/**
 * Strip the leading package identifier from a templateId, returning the
 * stable `:Module:Entity` suffix. The codegen-emitted `Template.templateId`
 * constant uses `#package-name:Module:Entity`; the wire templateId on
 * events returned by the JSON Ledger API uses
 * `<package-id-hash>:Module:Entity`. They aren't equal but they share
 * this tail — matching on the tail lets lookup helpers work regardless
 * of which form the caller has.
 */
function templateIdSuffix(templateId: string): string {
  const firstColon = templateId.indexOf(":");
  return firstColon >= 0 ? templateId.slice(firstColon) : ":" + templateId;
}

/**
 * Collect every contractId that was archived somewhere in `events`. A
 * transient contract created within the same transaction (e.g. an
 * intermediate holding inside an `AmuletRules_Transfer`) will show up as
 * both a `CreatedEvent` and a later `ArchivedEvent` with the same
 * contractId; the lookup helpers below skip such transient creates so the
 * caller only ever sees contracts that are LIVE at the end of the tx.
 */
function archivedContractIds(
  events: SortedEvents<object, unknown>,
): Set<string> {
  const out = new Set<string>();
  for (const e of events) {
    if (e.type === "archive") {
      out.add(e.contractId as unknown as string);
    }
  }
  return out;
}

/**
 * Find the first LIVE {@link CreateEvent} in `events` whose `templateId`
 * matches the given codegen `template` constant. A create is "live" iff
 * the same `contractId` does NOT also appear in an `ArchivedEvent` in the
 * same events list — i.e. the contract survived the transaction. "First"
 * means lowest `nodeId` (earliest in the transaction tree), not first in
 * the array.
 *
 * Use this on the return value of {@link Ledger.exercise} /
 * {@link Ledger.submitWithDisclosures} to grab a contract that was
 * created as a side effect of the choice body — e.g. when a
 * `PendingLoan.Fund` choice's body creates a `Loan` and you want that
 * `Loan`'s cid out of the resulting event tree:
 *
 * ```ts
 * const events = await ledger.exercise(C7Lock.PendingLoan.Fund, cid, args);
 * const loan = lookupCreatedEvent(events, C7Lock.Loan);
 * if (!loan) throw new Error("Fund did not yield a Loan");
 * // loan.contractId is ContractId<C7Lock.Loan> — typed, no cast needed.
 * ```
 *
 * Transient creates (created and archived in the same transaction) are
 * skipped because callers almost always want the contract that persists
 * past the tx, not an intermediate one. Use {@link lookupCreatedEvents}
 * and filter manually if you need a different policy.
 *
 * For the choice's own declared return value (the `R` of
 * `Choice<T, C, R, K>`), prefer reading that directly — it's statically
 * known. Use this helper for genuine side-effect lookups where the
 * created contract is NOT part of the choice's declared return.
 *
 * @param events Events from `ledger.exercise` or `submitWithDisclosures`.
 * @param template The codegen-emitted template constant for the contract
 *   you're looking for.
 * @returns The first matching LIVE CreateEvent (lowest nodeId), or
 *   `undefined` if none.
 */
export function lookupCreatedEvent<T extends object, K, TID extends string>(
  events: SortedEvents<object, unknown>,
  template: Template<T, K, TID>,
): CreateEvent<T, K> | undefined {
  const suffix = templateIdSuffix(template.templateId);
  const archived = archivedContractIds(events);
  // The discriminant narrows to CreateEvent<object, unknown>; the templateId
  // suffix is what authorises the downcast to CreateEvent<T, K> — the type
  // system can't prove the payload shape from a runtime string match.
  for (const e of events) {
    if (
      e.type === "create" &&
      e.templateId.endsWith(suffix) &&
      !archived.has(e.contractId as unknown as string)
    ) {
      return e as unknown as CreateEvent<T, K>;
    }
  }
  return undefined;
}

/**
 * Find every LIVE {@link CreateEvent} in `events` whose `templateId`
 * matches the given `template`, returned in `nodeId` order. Like
 * {@link lookupCreatedEvent}, this skips transient creates (created and
 * archived in the same tx). Useful when a choice body creates several
 * contracts of the same template (e.g. a split that produces N output
 * holdings).
 */
export function lookupCreatedEvents<T extends object, K, TID extends string>(
  events: SortedEvents<object, unknown>,
  template: Template<T, K, TID>,
): CreateEvent<T, K>[] {
  const suffix = templateIdSuffix(template.templateId);
  const archived = archivedContractIds(events);
  const out: CreateEvent<T, K>[] = [];
  for (const e of events) {
    if (
      e.type === "create" &&
      e.templateId.endsWith(suffix) &&
      !archived.has(e.contractId as unknown as string)
    ) {
      out.push(e as unknown as CreateEvent<T, K>);
    }
  }
  return out;
}

/**
 * Find the first {@link ArchiveEvent} in `events` whose `templateId`
 * matches the given `template`, ordered by `nodeId`. Mirror of
 * {@link lookupCreatedEvent} for the archive side — useful for
 * verifying that a consuming choice archived the contract you expected.
 */
export function lookupArchivedEvent<T extends object, K, TID extends string>(
  events: SortedEvents<object, unknown>,
  template: Template<T, K, TID>,
): ArchiveEvent<T> | undefined {
  const suffix = templateIdSuffix(template.templateId);
  for (const e of events) {
    if (e.type === "archive" && e.templateId.endsWith(suffix)) {
      return e as unknown as ArchiveEvent<T>;
    }
  }
  return undefined;
}
