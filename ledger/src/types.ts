// Basic types for the new ledger implementation branded with value.proto string formats
import { ContractId, Party, Choice, Template, InterfaceCompanion } from "@daml/types";
import {
  PartyIdString,
  UserIdString,
  PackageIdString,
} from "./valueTypes";
import type { components } from "./generated/async-api";

// Error type from the Canton AsyncAPI schema
export type JsCantonError = components["schemas"]["JsCantonError"];

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
  templateId: PackageIdString;
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
};

/** 
 * An ArchiveEvent of a given template
 */
export type ArchiveEvent<T extends object> = {
  type: "archive";
  templateId: PackageIdString;
  contractId: ContractId<T>;
  witnessParties: Party[];
  offset: number;
};

export type Event<T extends object, K = unknown> = CreateEvent<T, K> | ArchiveEvent<T>;

/**
 * The Daml interface of the subscribed 'interfaceId'
 * 
 * We use 'templateId' here because the name specified in the codegen field,
 * though this is specified as 'interfaceId' in the OpenAPI spec.
 */
export type Interface<I extends object> = {
  type: "interface";
  templateId: PackageIdString;
  contractId: ContractId<I>;
  payload?: any;
  signatories: Party[];
  observers: Party[];
  key?: any;
  createdEventBlob: string;
  interfaceView: I;
  interfaceId: PackageIdString;
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
