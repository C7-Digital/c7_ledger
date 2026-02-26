import { ContractId } from "@daml/types";
import type { PackageIdString } from "@c7-digital/ledger";
import type { AcsLogger } from "./types.js";

export interface BaseTrackerConfig {
  identifier: PackageIdString;
  entityLabel: string;
  idLabel: string;
  addedVerb: string;
  dataLabel: string;
}

export type AddedCallback<T extends object, TEvent> = (
  contractId: ContractId<T>,
  data: T,
  event: TEvent,
) => Promise<void> | void;

export type ArchivedCallback<T extends object> = (
  contractId: ContractId<T>,
  data: T,
) => Promise<void> | void;

export abstract class BaseTracker<T extends object, TEvent> {
  private eventMap = new Map<ContractId<T>, TEvent>();
  private addedCallbacks: Map<string, AddedCallback<T, TEvent>> = new Map();
  private archivedCallbacks: Map<string, ArchivedCallback<T>> = new Map();
  private firstSeenAtMap = new Map<ContractId<T>, string>();
  private relevanceFn?: (data: T) => boolean;
  private logger: AcsLogger;
  private config: BaseTrackerConfig;

  constructor(
    config: BaseTrackerConfig,
    logger: AcsLogger,
    relevanceFn?: (data: T) => boolean,
  ) {
    this.config = config;
    this.logger = logger;
    this.relevanceFn = relevanceFn;
  }

  protected abstract extractData(event: TEvent): T;
  protected abstract extractContractId(event: TEvent): ContractId<T>;

  protected getDataByContractId(contractId: ContractId<T>): T | undefined {
    const event = this.eventMap.get(contractId);
    return event ? this.extractData(event) : undefined;
  }

  protected getEventByContractId(contractId: ContractId<T>): TEvent | undefined {
    return this.eventMap.get(contractId);
  }

  protected getAllDataEntries(): Map<ContractId<T>, T> {
    const result = new Map<ContractId<T>, T>();
    for (const [contractId, event] of this.eventMap.entries()) {
      result.set(contractId, this.extractData(event));
    }
    return result;
  }

  protected getAllEventEntries(): Map<ContractId<T>, TEvent> {
    return new Map(this.eventMap);
  }

  protected getAllEntriesWithMeta(): Array<{
    contractId: ContractId<T>;
    data: T;
    firstSeenAt: string;
  }> {
    const out: Array<{
      contractId: ContractId<T>;
      data: T;
      firstSeenAt: string;
    }> = [];
    for (const [id, event] of this.eventMap.entries()) {
      const ts = this.firstSeenAtMap.get(id) ?? new Date().toISOString();
      out.push({
        contractId: id,
        data: this.extractData(event),
        firstSeenAt: ts,
      });
    }
    return out;
  }

  protected hasEntry(contractId: ContractId<T>): boolean {
    return this.eventMap.has(contractId);
  }

  protected getEntryCount(): number {
    return this.eventMap.size;
  }

  protected getIdentifier(): PackageIdString {
    return this.config.identifier;
  }

  protected registerAddedCallback(key: string, callback: AddedCallback<T, TEvent>): void {
    if (this.addedCallbacks.has(key)) {
      throw new Error(`Callback with key ${key} already exists`);
    }
    this.addedCallbacks.set(key, callback);
  }

  protected removeAddedCallback(key: string): void {
    this.addedCallbacks.delete(key);
  }

  protected registerArchivedCallback(key: string, callback: ArchivedCallback<T>): void {
    if (this.archivedCallbacks.has(key)) {
      throw new Error(`Callback with key ${key} already exists`);
    }
    this.archivedCallbacks.set(key, callback);
  }

  protected removeRegisteredArchivedCallback(key: string): void {
    this.archivedCallbacks.delete(key);
  }

  protected async handleEventAdded(event: TEvent): Promise<void> {
    const contractId = this.extractContractId(event);
    const data = this.extractData(event);
    const { entityLabel, idLabel, identifier, addedVerb, dataLabel } = this.config;

    if (this.relevanceFn && !this.relevanceFn(data)) {
      this.logger.warn(`Ignoring irrelevant ${entityLabel}`, {
        [idLabel]: identifier,
        contractId: contractId.toString(),
        [dataLabel]: data,
      });
      return;
    }

    const capitalized = entityLabel.charAt(0).toUpperCase() + entityLabel.slice(1);
    this.logger.debug(`${capitalized} ${addedVerb}`, {
      [idLabel]: identifier,
      contractId: contractId.toString(),
    });

    this.eventMap.set(contractId, event);

    if (!this.firstSeenAtMap.has(contractId)) {
      this.firstSeenAtMap.set(contractId, new Date().toISOString());
    }

    for (const [, callback] of this.addedCallbacks) {
      try {
        await callback(contractId, data, event);
      } catch (error) {
        this.logger.error(
          `Error executing ${addedVerb} callback for ${identifier}`,
          error as Error,
          { contractId: contractId.toString() }
        );
      }
    }
  }

  protected async handleEventArchived(contractId: ContractId<T>): Promise<void> {
    const { entityLabel, idLabel, identifier } = this.config;
    const capitalized = entityLabel.charAt(0).toUpperCase() + entityLabel.slice(1);

    this.logger.debug(`${capitalized} archived`, {
      [idLabel]: identifier,
      contractId: contractId.toString(),
    });

    const event = this.eventMap.get(contractId);
    if (event) {
      const data = this.extractData(event);
      this.eventMap.delete(contractId);
      this.firstSeenAtMap.delete(contractId);

      for (const [, callback] of this.archivedCallbacks) {
        try {
          await callback(contractId, data);
        } catch (error) {
          this.logger.error(
            `Error executing archived callback for ${identifier}`,
            error as Error,
            { contractId: contractId.toString() }
          );
        }
      }
    }
  }

  public cleanup(): void {
    this.eventMap.clear();
    this.addedCallbacks.clear();
    this.archivedCallbacks.clear();
  }
}
