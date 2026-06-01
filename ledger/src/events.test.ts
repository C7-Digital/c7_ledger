/**
 * Tests for the event-lookup helpers exported from `./events` plus the
 * `sortEventsByNodeId` function in `./ledger` that produces the
 * `SortedEvents` brand the helpers consume.
 *
 * Pins three behaviours that are easy to regress accidentally:
 *
 *   1. Live-only filtering — a contract created AND archived in the
 *      same transaction is skipped by the lookup helpers.
 *   2. `nodeId`-ordering at the source — `sortEventsByNodeId` is the
 *      only way to produce a `SortedEvents`; the lookup helpers' input
 *      type forces callers (or the ledger) to apply it. The helpers
 *      themselves trust input order — they don't re-sort.
 *   3. Template-id suffix matching — works whether the input templateId
 *      is the codegen `#pkg-name:Module:Entity` form or the wire
 *      `<pkg-hash>:Module:Entity` form.
 */

import type { ContractId, Template } from "@daml/types";
import {
  lookupArchivedEvent,
  lookupCreatedEvent,
  lookupCreatedEvents,
} from "./events";
import { sortEventsByNodeId } from "./ledger";
import type { ArchiveEvent, CreateEvent, Event } from "./types";
import type { IdentifierString } from "./valueTypes";

// Minimal Template stub: the lookup helpers only read `.templateId`, so
// we don't need a real decoder/companion. The phantom T parameter is what
// makes the returned CreateEvent typed.
function makeTemplate<T extends object>(
  templateId: string,
): Template<T, undefined, string> {
  return { templateId } as unknown as Template<T, undefined, string>;
}

// Phantom payload types so the typed lookup return is meaningful, even
// though tests assert against the contractId only.
interface FakeLoan {
  borrower: string;
}
interface FakeAmulet {
  owner: string;
}

// Codegen-emitted constants (`#pkg-name:Module:Entity`).
const Loan = makeTemplate<FakeLoan>("#c7lock-model:C7Lock:Loan");
const Amulet = makeTemplate<FakeAmulet>(
  "#splice-amulet:Splice.Amulet:Amulet",
);

// Wire-shape template ids (what the JSON Ledger API actually returns):
// `<package-id-hash>:Module:Entity`. Suffix-match against the codegen
// constants above.
const WIRE_LOAN_TID = "deadbeef1234567890:C7Lock:Loan" as IdentifierString;
const WIRE_AMULET_TID =
  "abcd1234567890abcd:Splice.Amulet:Amulet" as IdentifierString;

function createEvt<T extends object>(opts: {
  templateId: IdentifierString;
  contractId: string;
  nodeId: number;
}): CreateEvent<T, undefined> {
  return {
    type: "create",
    templateId: opts.templateId,
    contractId: opts.contractId as unknown as ContractId<T>,
    payload: {} as T,
    signatories: [],
    observers: [],
    key: undefined,
    createdEventBlob: "",
    nodeId: opts.nodeId,
  };
}

function archiveEvt<T extends object>(opts: {
  templateId: IdentifierString;
  contractId: string;
  nodeId: number;
}): ArchiveEvent<T> {
  return {
    type: "archive",
    templateId: opts.templateId,
    contractId: opts.contractId as unknown as ContractId<T>,
    witnessParties: [],
    offset: 0,
    nodeId: opts.nodeId,
  };
}

/** Brand a plain `Event[]` for tests — same effect as the ledger does. */
function sorted(events: Event<object, unknown>[]) {
  return sortEventsByNodeId(events);
}

describe("sortEventsByNodeId", () => {
  it("returns events in ascending nodeId order", () => {
    const events: Event<object, unknown>[] = [
      createEvt<FakeLoan>({
        templateId: WIRE_LOAN_TID,
        contractId: "C",
        nodeId: 5,
      }),
      createEvt<FakeLoan>({
        templateId: WIRE_LOAN_TID,
        contractId: "A",
        nodeId: 1,
      }),
      archiveEvt<FakeLoan>({
        templateId: WIRE_LOAN_TID,
        contractId: "B",
        nodeId: 3,
      }),
    ];
    expect(sortEventsByNodeId(events).map((e) => e.nodeId)).toEqual([1, 3, 5]);
  });

  it("does not mutate the input array", () => {
    const events: Event<object, unknown>[] = [
      createEvt<FakeLoan>({
        templateId: WIRE_LOAN_TID,
        contractId: "B",
        nodeId: 3,
      }),
      createEvt<FakeLoan>({
        templateId: WIRE_LOAN_TID,
        contractId: "A",
        nodeId: 1,
      }),
    ];
    const before = events.map((e) => e.nodeId);
    sortEventsByNodeId(events);
    expect(events.map((e) => e.nodeId)).toEqual(before);
  });

  it("accepts an already-sorted input (idempotent)", () => {
    const events: Event<object, unknown>[] = [
      createEvt<FakeLoan>({
        templateId: WIRE_LOAN_TID,
        contractId: "A",
        nodeId: 1,
      }),
      createEvt<FakeLoan>({
        templateId: WIRE_LOAN_TID,
        contractId: "B",
        nodeId: 2,
      }),
    ];
    expect(sortEventsByNodeId(events).map((e) => e.nodeId)).toEqual([1, 2]);
  });
});

describe("lookupCreatedEvent", () => {
  it("returns the matching create when it's the only event", () => {
    const events = sorted([
      createEvt<FakeLoan>({
        templateId: WIRE_LOAN_TID,
        contractId: "loan-A",
        nodeId: 1,
      }),
    ]);
    expect(lookupCreatedEvent(events, Loan)?.contractId).toBe(
      "loan-A" as unknown as ContractId<FakeLoan>,
    );
  });

  it("skips a transient create (created and archived in same tx) and returns the later live one", () => {
    // [Create A:Loan (1), Archive A:Loan (2), Create B:Loan (3)]
    const events = sorted([
      createEvt<FakeLoan>({
        templateId: WIRE_LOAN_TID,
        contractId: "loan-A",
        nodeId: 1,
      }),
      archiveEvt<FakeLoan>({
        templateId: WIRE_LOAN_TID,
        contractId: "loan-A",
        nodeId: 2,
      }),
      createEvt<FakeLoan>({
        templateId: WIRE_LOAN_TID,
        contractId: "loan-B",
        nodeId: 3,
      }),
    ]);
    expect(lookupCreatedEvent(events, Loan)?.contractId).toBe(
      "loan-B" as unknown as ContractId<FakeLoan>,
    );
  });

  it("ignores creates of other templates", () => {
    const events = sorted([
      createEvt<FakeAmulet>({
        templateId: WIRE_AMULET_TID,
        contractId: "amulet-X",
        nodeId: 1,
      }),
      createEvt<FakeLoan>({
        templateId: WIRE_LOAN_TID,
        contractId: "loan-L",
        nodeId: 2,
      }),
    ]);
    expect(lookupCreatedEvent(events, Loan)?.contractId).toBe(
      "loan-L" as unknown as ContractId<FakeLoan>,
    );
  });

  it("returns undefined when no create matches the template", () => {
    const events = sorted([
      createEvt<FakeAmulet>({
        templateId: WIRE_AMULET_TID,
        contractId: "amulet-X",
        nodeId: 1,
      }),
    ]);
    expect(lookupCreatedEvent(events, Loan)).toBeUndefined();
  });

  it("returns undefined when the only matching create is transient", () => {
    const events = sorted([
      createEvt<FakeLoan>({
        templateId: WIRE_LOAN_TID,
        contractId: "loan-A",
        nodeId: 1,
      }),
      archiveEvt<FakeLoan>({
        templateId: WIRE_LOAN_TID,
        contractId: "loan-A",
        nodeId: 2,
      }),
    ]);
    expect(lookupCreatedEvent(events, Loan)).toBeUndefined();
  });

  it("returns undefined for an empty events array", () => {
    expect(lookupCreatedEvent(sorted([]), Loan)).toBeUndefined();
  });
});

describe("lookupCreatedEvents", () => {
  it("returns all live creates of the template in nodeId order", () => {
    // Composite: transient loan-X gets skipped; loan-A/B come back in nodeId
    // order; amulet-X is a non-matching template.
    const events = sorted([
      createEvt<FakeLoan>({
        templateId: WIRE_LOAN_TID,
        contractId: "loan-A",
        nodeId: 1,
      }),
      createEvt<FakeLoan>({
        templateId: WIRE_LOAN_TID,
        contractId: "loan-X",
        nodeId: 2,
      }),
      archiveEvt<FakeLoan>({
        templateId: WIRE_LOAN_TID,
        contractId: "loan-X",
        nodeId: 3,
      }),
      createEvt<FakeLoan>({
        templateId: WIRE_LOAN_TID,
        contractId: "loan-B",
        nodeId: 4,
      }),
      createEvt<FakeAmulet>({
        templateId: WIRE_AMULET_TID,
        contractId: "amulet-X",
        nodeId: 5,
      }),
    ]);
    const ids = lookupCreatedEvents(events, Loan).map((c) => c.contractId);
    expect(ids).toEqual([
      "loan-A" as unknown as ContractId<FakeLoan>,
      "loan-B" as unknown as ContractId<FakeLoan>,
    ]);
  });

  it("returns an empty array when no creates match", () => {
    expect(lookupCreatedEvents(sorted([]), Loan)).toEqual([]);
  });
});

describe("lookupArchivedEvent", () => {
  it("returns the first archive matching the template (lowest nodeId)", () => {
    const events = sorted([
      archiveEvt<FakeLoan>({
        templateId: WIRE_LOAN_TID,
        contractId: "loan-A",
        nodeId: 2,
      }),
      archiveEvt<FakeLoan>({
        templateId: WIRE_LOAN_TID,
        contractId: "loan-B",
        nodeId: 5,
      }),
    ]);
    expect(lookupArchivedEvent(events, Loan)?.contractId).toBe(
      "loan-A" as unknown as ContractId<FakeLoan>,
    );
  });

  it("does not consider creates", () => {
    const events = sorted([
      createEvt<FakeLoan>({
        templateId: WIRE_LOAN_TID,
        contractId: "loan-A",
        nodeId: 1,
      }),
    ]);
    expect(lookupArchivedEvent(events, Loan)).toBeUndefined();
  });

  it("ignores archives of other templates", () => {
    const events = sorted([
      archiveEvt<FakeAmulet>({
        templateId: WIRE_AMULET_TID,
        contractId: "amulet-X",
        nodeId: 1,
      }),
    ]);
    expect(lookupArchivedEvent(events, Loan)).toBeUndefined();
  });
});
