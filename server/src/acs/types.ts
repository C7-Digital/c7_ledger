import { ContractId, TemplateOrInterface } from "@daml/types";
import { CreateEvent, PackageIdString } from "@c7-digital/ledger";

/**
 * Helper type to extract the payload type from a template or interface companion
 */
export type PayloadOf<TI> = TI extends TemplateOrInterface<infer P, any, any> ? P : never;

/**
 * Logger interface for ActiveContractsService.
 * Matches the structured JSON logging pattern used by Canton apps.
 */
export interface AcsLogger {
  debug(message: string, context?: Record<string, any>): void;
  info(message: string, context?: Record<string, any>): void;
  warn(message: string, context?: Record<string, any>): void;
  error(message: string, error?: Error, context?: Record<string, any>): void;
}

/**
 * No-op logger that discards all messages.
 * Used as default when no logger is injected.
 */
export const noOpLogger: AcsLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

// Callback types for template trackers
export type ContractCreatedCallback<T extends object> = (
  contractId: ContractId<T>,
  payload: T,
  createEvent: CreateEvent<T>
) => Promise<void> | void;

export type ContractArchivedCallback<T extends object> = (
  contractId: ContractId<T>,
  payload: T
) => Promise<void> | void;

// Callback types for interface trackers
export type InterfaceViewedCallback<I extends object> = (
  contractId: ContractId<I>,
  view: I,
  interfaceEvent: import("@c7-digital/ledger").Interface<I>
) => Promise<void> | void;

export type InterfaceArchivedCallback<I extends object> = (
  contractId: ContractId<I>,
  view: I
) => Promise<void> | void;

/**
 * Generic type for a contract with its ID and payload
 */
export type ContractWithPayload<T> = {
  contractId: ContractId<T>;
  payload: T;
};

// Type-safe tracker registry interface
export interface TrackerRegistry {
  has(templateId: PackageIdString): boolean;
  get<T extends object>(templateId: PackageIdString): import("./templateTracker.js").TemplateTracker<T> | undefined;
  set<T extends object>(templateId: PackageIdString, tracker: import("./templateTracker.js").TemplateTracker<T>): void;
  length(): number;
  values(): Iterable<import("./templateTracker.js").TemplateTracker<any>>;
  keys(): Iterable<PackageIdString>;
}

// Type-safe interface tracker registry interface
export interface InterfaceTrackerRegistry {
  has(interfaceId: PackageIdString): boolean;
  get<I extends object>(interfaceId: PackageIdString): import("./interfaceTracker.js").InterfaceTracker<I> | undefined;
  set<I extends object>(interfaceId: PackageIdString, tracker: import("./interfaceTracker.js").InterfaceTracker<I>): void;
  length(): number;
  values(): Iterable<import("./interfaceTracker.js").InterfaceTracker<any>>;
  keys(): Iterable<PackageIdString>;
}
