// Basic types for the new ledger implementation branded with value.proto string formats
import { ContractId, Party, Choice, Template, InterfaceCompanion } from "@daml/types";
import {
  LedgerString,
  PartyIdString,
  UserIdString,
  NameString,
  PackageIdString,
} from "./valueTypes";
import { JsCantonError } from "./websocket";

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
 * interface we really mean the interfaceId as in the spec OpenAPI spec.
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
 * The return interface of streamQuery and streamQueries.
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
}

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
}

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
