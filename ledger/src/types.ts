// Basic types for the new ledger implementation branded with value.proto string formats
import { ContractId, Party, Choice, Template, InterfaceCompanion } from "@daml/types";
import {
  PartyIdString,
  UserIdString,
  IdentifierString,
  isValidLedgerString,
  createIdentifierString,
} from "./valueTypes";
import type { components } from "./generated/async-api";
import type { components as apiComponents } from "./generated/api";

// Error type from the Canton AsyncAPI schema
export type JsCantonError = components["schemas"]["JsCantonError"];

/**
 * An on-ledger contract attached to a command submission so the
 * Daml engine can resolve a contract lookup the submitter doesn't
 * have visibility into otherwise.
 *
 * Two ways to come by one:
 *
 *   1. **From your own ACS.** `useStreamQuery` / `useQuery` /
 *      `streamQuery` already return a {@link CreateEvent} with
 *      `createdEventBlob` populated (when `includeCreatedEventBlob`
 *      is true — the default for the React hooks). Pass the event
 *      to {@link toDisclosedContract} together with the synchronizer
 *      id the contract is hosted on.
 *
 *   2. **From a registry/scan node.** For DSO-owned contracts you
 *      don't see — `AmuletRules`, an `OpenMiningRound`, a
 *      `LockedAmulet` whose holders you're not party to — the Splice
 *      scan node mirrors the ACS and exposes the same fields
 *      (`contract_id`, `created_event_blob`, `template_id`, plus a
 *      `domain_id` at the wrapper). Pack them by hand:
 *
 *      ```ts
 *      { contractId, createdEventBlob, templateId, synchronizerId }
 *      ```
 */
export type DisclosedContract = apiComponents["schemas"]["DisclosedContract"];

// Type guard to check if a response is a JsCantonError
export function isCantonError(response: unknown): response is JsCantonError {
  return (
    typeof response === "object" &&
    response !== null &&
    "code" in response &&
    "cause" in response &&
    "context" in response
  );
}

// Generic CreateEvent
export type CreateEvent<T extends object, K = unknown> = {
  type: "create";
  templateId: IdentifierString;
  contractId: ContractId<T>;
  payload: T;
  signatories: Party[];
  observers: Party[];
  key?: K;
  createdEventBlob: string;
  /**
   * Package version string (e.g., "0.0.6")
   * Only present if using VersionedRegistry
   */
  packageVersion?: string;
  /**
   * Synchronizer (Canton domain) the contract is hosted on. Carried
   * through from `JsActiveContract.synchronizerId` (ACS path) or
   * `JsTransaction.synchronizerId` (transaction stream / `submit`
   * response). Always populated by streamed contracts from this
   * library; pass to {@link toDisclosedContract} so callers don't
   * have to thread the synchronizer separately.
   */
  synchronizerId?: string;
  /**
   * The position of this event within the originating transaction tree.
   * Required by the Ledger API on every wire CreatedEvent; carried
   * through here so callers can order events deterministically (and so
   * event-lookup helpers can sort defensively rather than trust the
   * response array's order — the proto declares `repeated Event events`
   * without an explicit ordering guarantee).
   */
  nodeId: number;
};

/**
 * Convert a {@link CreateEvent} streamed from the ledger into a
 * {@link DisclosedContract} suitable for `submitWithDisclosures`.
 *
 * The CreateEvent must have been streamed with
 * `includeCreatedEventBlob: true` — the default for `useStreamQuery` /
 * `useQuery` — otherwise the disclosed blob is empty and the JSON
 * API will reject the submission. Both `createdEventBlob` and
 * `synchronizerId` are populated by every decode path in this
 * library; if either is missing, the event was sourced from
 * somewhere unusual — construct a `DisclosedContract` directly
 * instead of going through this helper.
 */
export function toDisclosedContract<T extends object, K = unknown>(
  event: CreateEvent<T, K>,
): DisclosedContract {
  if (!event.createdEventBlob) {
    throw new Error(
      `toDisclosedContract: contract ${event.contractId} has no createdEventBlob — re-stream with includeCreatedEventBlob: true`,
    );
  }
  if (!event.synchronizerId) {
    throw new Error(
      `toDisclosedContract: contract ${event.contractId} has no synchronizerId — was it decoded by this library?`,
    );
  }
  return {
    contractId: event.contractId as unknown as string,
    createdEventBlob: event.createdEventBlob,
    templateId: event.templateId,
    synchronizerId: event.synchronizerId,
  };
}

/**
 * The plain-string shape a disclosure arrives in when it travels over an
 * untyped channel — your own backend API, or a registry/scan node response.
 * All fields are wire strings (no brands), mirroring `created_event_blob` /
 * `contract_id` / `template_id` / `domain_id` from those sources.
 */
export type WireDisclosedContract = {
  contractId: string;
  createdEventBlob: string;
  /** Full template id in package-id-reference format (`pkgId:Module:Entity`). */
  templateId: string;
  synchronizerId: string;
};

/**
 * Build a {@link DisclosedContract} from raw wire strings. This is the
 * constructor counterpart to {@link toDisclosedContract}: use that when you
 * hold a library-decoded {@link CreateEvent}, and use this when a disclosure
 * round-tripped through an untyped channel (your tRPC/REST API, a scan node)
 * and all you have are plain strings — see case 2 in the {@link
 * DisclosedContract} docs. Branding happens here, once, instead of at every
 * call site.
 *
 * `createdEventBlob` and `synchronizerId` must be non-empty (the JSON API
 * rejects a submission otherwise).
 */
export function disclosedContractFromWire(
  wire: WireDisclosedContract,
): DisclosedContract {
  if (!wire.createdEventBlob) {
    throw new Error(
      "disclosedContractFromWire: createdEventBlob is empty — the JSON API will reject the submission",
    );
  }
  if (!wire.synchronizerId) {
    throw new Error(
      "disclosedContractFromWire: synchronizerId is empty — the contract's hosting synchronizer is required",
    );
  }
  return {
    contractId: wire.contractId,
    createdEventBlob: wire.createdEventBlob,
    // A template id is a qualified identifier ("pkgId:Module:Entity"), so it
    // carries the IdentifierString brand — validated and branded here, not a
    // bare PackageIdString cast (the bare-package-id validator would reject the
    // colons).
    templateId: createIdentifierString(wire.templateId),
    synchronizerId: wire.synchronizerId,
  };
}

/**
 * Brand a raw contract-id string into a typed {@link ContractId}. Reach for
 * this at a wire boundary where the id arrives as a plain string (relayed
 * through your own backend, a registry response) but a typed API — e.g. an
 * {@link ExerciseCommand}'s `contractId: ContractId<T>` — needs the brand.
 * The value is validated against the `LedgerString` format that contract ids
 * use; the unchecked brand cast lives here, once, not at every call site.
 */
export function createContractId<T extends object>(value: string): ContractId<T> {
  if (!isValidLedgerString(value)) {
    throw new Error(
      `Invalid ContractId: "${value}". Must match the LedgerString format [A-Za-z0-9#:\\-_/ ]+ (≤ 255 chars)`,
    );
  }
  return value as unknown as ContractId<T>;
}

/**
 * An ArchiveEvent of a given template
 */
export type ArchiveEvent<T extends object> = {
  type: "archive";
  templateId: IdentifierString;
  contractId: ContractId<T>;
  witnessParties: Party[];
  offset: number;
  /**
   * The position of this event within the originating transaction tree.
   * See {@link CreateEvent.nodeId} — same semantics; required by the
   * Ledger API on every wire ArchivedEvent.
   */
  nodeId: number;
};

export type Event<T extends object, K = unknown> = CreateEvent<T, K> | ArchiveEvent<T>;

// Phantom marker for the {@link SortedEvents} brand below. `declare const`
// + `unique symbol` produces a compile-time-only identifier — there is no
// runtime property added to the array.
declare const NodeIdSorted: unique symbol;

/**
 * A readonly array of events that is GUARANTEED to be sorted by `nodeId`
 * ascending — i.e. in canonical preorder-traversal position within the
 * originating transaction tree.
 *
 * The brand is type-only (the phantom `[NodeIdSorted]` property never
 * exists at runtime), so the only way to obtain a `SortedEvents` value is
 * via {@link sortEventsByNodeId} or by accepting one from
 * {@link Ledger.exercise} / {@link Ledger.submit} /
 * {@link Ledger.submitWithDisclosures} — all of which apply the sort.
 *
 * Consumer helpers (`lookupCreatedEvent`, etc.) declare their input as
 * `SortedEvents`, so callers can't accidentally feed them an unordered
 * array — the type-checker forces an explicit `sortEventsByNodeId` call
 * at the boundary if they're assembling events from a non-ledger source.
 *
 * Assignable to `ReadonlyArray<Event<T, K>>` (it's a subtype via the
 * intersection), so existing functions that take a plain event array
 * accept it without change.
 */
export type SortedEvents<T extends object = object, K = unknown> =
  ReadonlyArray<Event<T, K>> & { readonly [NodeIdSorted]: true };

// `lookupCreatedEvent` / `lookupCreatedEvents` / `lookupArchivedEvent` live
// in `./events` — they're functions, not types. Re-exported from this
// package's entry point.

/**
 * The Daml interface of the subscribed 'interfaceId'
 * 
 * We use 'templateId' here because the name specified in the codegen field,
 * though this is specified as 'interfaceId' in the OpenAPI spec.
 */
export type Interface<I extends object> = {
  type: "interface";
  templateId: IdentifierString;
  contractId: ContractId<I>;
  payload?: any;
  signatories: Party[];
  observers: Party[];
  key?: any;
  createdEventBlob: string;
  interfaceView: I;
  interfaceId: IdentifierString;
  /**
   * Package version string (e.g., "0.0.6")
   * Only present if using VersionedRegistry
   */
  packageVersion?: string;
};

export type VersionedLookupResult
  = { type: "template", template: Template<object, unknown, string>, version: string }
  | { type: "interface", interface_: InterfaceCompanion<object, unknown, string>, version: string };

/**
 * By default the codegen models use @daml/types registerTemplate function to
 * add the Template instance to a map. This is insufficient on two counts; it
 * does not track the packageId of the containing dar, which is what the stream
 * returns. Furthermore, it does not register the InterfaceView instance which
 * one can also get from the stream.
 * 
 * This type can be passed into our Ledger so that we can use it instead. We
 * overload the name of the lookup parameter 'templateId' even though in the
 * interface we really mean the interfaceId as in the OpenAPI spec.
 */
export type VersionedRegistry = (
  templateId: string
) => VersionedLookupResult | undefined;

export type LedgerOffset = "start" | "end" | number;

export type CantonError = JsCantonError;

export interface StreamCloseEvent {
  code: number;
  reason: string;
}

export type StreamState =
  | "start" // After construction, waiting on user to setup listeners
  | "init" // After listeners setup and stop called, processing ACS
  | "live" // After ACS loaded (or ACS skipped), processing transactions
  | "stop"; // Stop called, cleaning up

/**
 * The return interface of streamTemplate - for template-specific streaming with known types.
 */
export interface Stream<T extends object, K> {
  on(type: "create", listener: (event: CreateEvent<T, K>) => void): void;
  on(type: "archive", listener: (event: ArchiveEvent<T>) => void): void;
  on(type: "error", listener: (event: CantonError) => void): void;
  on(type: "state", listener: (event: StreamState) => void): void;
  off(type: "create", listener: (event: CreateEvent<T, K>) => void): void;
  off(type: "archive", listener: (event: ArchiveEvent<T>) => void): void;
  off(type: "error", listener: (event: CantonError) => void): void;
  off(type: "state", listener: (event: StreamState) => void): void;
  start(): void;
  state(): StreamState;
  close(): void;
  updateToken(newToken: string): void;
}

/**
 * Additional interface-specific methods for interface streaming.
 */
export interface InterfaceStreamMethods<I extends object> {
  on(type: "interfaceView", listener: (event: Interface<I>) => void): void;
  off(type: "interfaceView", listener: (event: Interface<I>) => void): void;
}

/**
 * The return interface of streamInterface - combines Stream with interface-specific events.
 * 
 * Most of the time, if you are subscribing to an interface, the underlying
 * template is operationally not interesting to you (otherwise, you would be
 * subscribing to the template directly). Consequently we will emit the
 * template related events but not make an effort to decode them.
 */
export type InterfaceStream<I extends object> = Stream<object, unknown> & InterfaceStreamMethods<I>;

/**
 * Template mapping type for MultiStream:
 * template IDs to their corresponding contract and key types
 */
export type TemplateMapping = Record<
  string,
  {
    contractType: object;
    keyType: unknown;
  }
>;

/**
 * Interface mapping type for InterfaceMultiStream:
 * interface IDs to their corresponding contract types
 */
export type InterfaceMapping = Record<
  string,
  {
    contractType: object;
  }
>;

/**
 * Interface-specific methods for MultiStream
 */
export interface InterfaceMultiStreamMethods<IM extends InterfaceMapping> {
  /**
   * Register a listener for interfaceView events for a specific interface
   * @param interfaceId The interface ID to listen for
   * @param listener The callback function that will receive properly typed interface events
   */
  onInterfaceView<IID extends keyof IM>(
    interfaceId: IID,
    listener: (event: Interface<IM[IID]["contractType"]>) => void
  ): void;

  /**
   * Remove an interfaceView event listener for a specific interface
   * @param interfaceId The interface ID to stop listening for
   * @param listener The callback function to remove
   */
  offInterfaceView<IID extends keyof IM>(
    interfaceId: IID,
    listener: (event: Interface<IM[IID]["contractType"]>) => void
  ): void;
}

/**
 * Provides template-specific event handlers.
 */
export interface MultiStream<TM extends TemplateMapping> {
  /**
   * Register a listener for create events for a specific template
   * @param templateId The template ID to listen for
   * @param listener The callback function that will receive properly typed events
   */
  onCreate<TID extends keyof TM>(
    templateId: TID,
    listener: (event: CreateEvent<TM[TID]["contractType"], TM[TID]["keyType"]>) => void
  ): void;

  /**
   * Register a listener for archive events for a specific template
   * @param templateId The template ID to listen for
   * @param listener The callback function that will receive properly typed events
   */
  onArchive<TID extends keyof TM>(
    templateId: TID,
    listener: (event: ArchiveEvent<TM[TID]["contractType"]>) => void
  ): void;

  /**
   * Register a listener for error events
   * @param listener The callback function that will receive error events
   */
  onError(listener: (error: CantonError) => void): void;

  onState(listener: (state: StreamState) => void): void;

  /**
   * Remove a create event listener for a specific template
   * @param templateId The template ID to stop listening for
   * @param listener The callback function to remove
   */
  offCreate<TID extends keyof TM>(
    templateId: TID,
    listener: (event: CreateEvent<TM[TID]["contractType"], TM[TID]["keyType"]>) => void
  ): void;

  /**
   * Remove an archive event listener for a specific template
   * @param templateId The template ID to stop listening for
   * @param listener The callback function to remove
   */
  offArchive<TID extends keyof TM>(
    templateId: TID,
    listener: (event: ArchiveEvent<TM[TID]["contractType"]>) => void
  ): void;

  /**
   * Remove an error event listener
   * @param listener The callback function to remove
   */
  offError(listener: (error: CantonError) => void): void;

  offState(listener: (state: StreamState) => void): void;

  start(): void;
  state(): StreamState;
  close(): void;
  updateToken(newToken: string): void;
}

/**
 * Derives a TemplateMapping from an InterfaceMapping
 * Templates underlying interfaces have generic object contractType and unknown keyType
 */
type DerivedTemplateMapping<IM extends InterfaceMapping> = {
  [K in keyof IM]: {
    contractType: object;
    keyType: unknown;
  }
};

/**
 * Extended MultiStream interface that includes interface-specific event handlers
 * Similar to how InterfaceStream extends Stream
 * Derives the template mapping from the interface mapping since interfaces are implemented for templates
 */
export type InterfaceMultiStream<IM extends InterfaceMapping> = MultiStream<DerivedTemplateMapping<IM>> & InterfaceMultiStreamMethods<IM>;

export interface Query<T = unknown> {
  [key: string]: unknown;
}

// Command submission types with proper value.proto string formats
export type CreateCommand<T extends object, K = unknown> = {
  type: 'create';
  template: Template<T, K, string>;
  payload: T;
};

export type CreateAndExerciseCommand<T extends object, C, R, K = unknown> = {
  type: 'createAndExercise';
  template: Template<T, K, string>;
  payload: T;
  choice: Choice<T, C, R, K>;
  argument: C;
};

export type ExerciseCommand<T extends object, C, R, K = unknown> = {
  type: 'exercise';
  choice: Choice<T, C, R, K>;
  contractId: ContractId<T>;
  argument: C;
};

export type Command<T extends object, C, R = unknown, K = unknown>
  = CreateCommand<T, K>
  | CreateAndExerciseCommand<T, C, R, K>
  | ExerciseCommand<T, C, R, K>;

/**
 * A command with erased type parameters, suitable for heterogeneous arrays
 * passed to `Ledger.submit()`. Each variant is independently widened to `any`,
 * so a `CreateCommand<A, KA>` and an `ExerciseCommand<B, CB, RB, KB>` can
 * coexist in the same `AnyCommand[]` without a cast.
 */
export type AnyCommand =
  | CreateCommand<any, any>
  | CreateAndExerciseCommand<any, any, any, any>
  | ExerciseCommand<any, any, any, any>;

// Party management types with proper string formats
export interface AllocatePartyRequest {
  partyIdHint?: PartyIdString;
  displayName?: string;
}

export interface AllocatePartyResponse {
  partyDetails: PartyDetails;
}

export interface PartyDetails {
  party: Party;
  displayName?: string;
  isLocal: boolean;
}

export type UserRight =
  | { type: "canActAs"; party: Party }
  | { type: "canReadAs"; party: Party }
  | { type: "canReadAsAnyParty" }
  | { type: "empty" }
  | { type: "identityProviderAdmin" }
  | { type: "participantAdmin" };

export interface User {
  userId: UserIdString;
  primaryParty?: Party;
  rights: UserRight[];
}
