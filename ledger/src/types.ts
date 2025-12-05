// Basic types for the new ledger implementation branded with value.proto string formats
import { ContractId, Party, List } from "@daml/types";
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
  signatories: List<Party>;
  observers: List<Party>;
  key?: K;
  createdEventBlob: string;
  /**
   * Package version string (e.g., "0.0.6")
   * Only present if using versionedTemplateRegistry
   */
  packageVersion?: string;
};

// Event types for compatibility
// export type ArchiveEvent<T extends object, I extends string = string> = {
export type ArchiveEvent<T extends object> = {
  type: "archive";
  templateId: PackageIdString;
  contractId: ContractId<T>;
  witnessParties: Party[];
  offset: number;
};

export type Event<T extends object, K = unknown> = CreateEvent<T, K> | ArchiveEvent<T>;

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
export type CreateCommand<T = unknown> = {
  type: 'create';
  templateId: string; // This would be a template identifier format
  payload: T;
};

export type CreateAndExerciseCommand<T = unknown, R = unknown> = {
  type: 'createAndExercise';
  templateId: string;
  payload: T;
  choice: NameString;
  argument: R;
};

export type ExerciseCommand<T = unknown, R = unknown> = {
  type: 'exercise';
  templateId: string;
  contractId: ContractId<T>;
  choice: NameString;
  argument: R;
};

export type Command<T = unknown, R = unknown> 
  = CreateCommand<T> 
  | CreateAndExerciseCommand<T, R> 
  | ExerciseCommand<T, R>;

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
