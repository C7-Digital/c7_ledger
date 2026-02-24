import { ContractId, Template } from "@daml/types";
import { CreateEvent, PackageIdString } from "@c7-digital/ledger";
import type { ContractCreatedCallback, ContractArchivedCallback, AcsLogger } from "./types.js";

export class TemplateTracker<T extends object> {
  private contractMap = new Map<ContractId<T>, CreateEvent<T>>();
  private createdCallbacks: Map<string, ContractCreatedCallback<T>> = new Map();
  private archivedCallbacks: Map<string, ContractArchivedCallback<T>> = new Map();
  private contractTemplate: Template<T, any, PackageIdString>;
  private relevanceFn?: (payload: T) => boolean;
  private firstSeenAtMap = new Map<ContractId<T>, string>();
  private logger: AcsLogger;

  constructor(
    contractTemplate: Template<T, any, PackageIdString>,
    logger: AcsLogger,
    relevanceFn?: (payload: T) => boolean,
  ) {
    this.contractTemplate = contractTemplate;
    this.logger = logger;
    this.relevanceFn = relevanceFn;
  }

  public getPayload(contractId: ContractId<T>): T | undefined {
    const createEvent = this.contractMap.get(contractId);
    return createEvent?.payload;
  }

  public getCreateEvent(contractId: ContractId<T>): CreateEvent<T> | undefined {
    return this.contractMap.get(contractId);
  }

  public getAllContracts(): Map<ContractId<T>, T> {
    const result = new Map<ContractId<T>, T>();
    for (const [contractId, createEvent] of this.contractMap.entries()) {
      result.set(contractId, createEvent.payload);
    }
    return result;
  }

  public getAllCreateEvents(): Map<ContractId<T>, CreateEvent<T>> {
    return new Map(this.contractMap);
  }

  public getAllContractsWithMeta(): Array<{
    contractId: ContractId<T>;
    payload: T;
    firstSeenAt: string;
  }> {
    const out: Array<{
      contractId: ContractId<T>;
      payload: T;
      firstSeenAt: string;
    }> = [];
    for (const [id, createEvent] of this.contractMap.entries()) {
      const ts = this.firstSeenAtMap.get(id) ?? new Date().toISOString();
      out.push({
        contractId: id,
        payload: createEvent.payload,
        firstSeenAt: ts,
      });
    }
    return out;
  }

  public hasContract(contractId: ContractId<T>): boolean {
    return this.contractMap.has(contractId);
  }

  public getContractCount(): number {
    return this.contractMap.size;
  }

  public getTemplateId(): PackageIdString {
    return this.contractTemplate.templateId;
  }

  public onCreated(key: string, callback: ContractCreatedCallback<T>): void {
    if (this.createdCallbacks.has(key)) {
      throw new Error(`Callback with key ${key} already exists`);
    }
    this.createdCallbacks.set(key, callback);
  }

  public removeCreatedCallback(key: string): void {
    this.createdCallbacks.delete(key);
  }

  public onArchived(key: string, callback: ContractArchivedCallback<T>): void {
    if (this.archivedCallbacks.has(key)) {
      throw new Error(`Callback with key ${key} already exists`);
    }
    this.archivedCallbacks.set(key, callback);
  }

  public removeArchivedCallback(key: string): void {
    this.archivedCallbacks.delete(key);
  }

  public async handleContractCreated(createEvent: CreateEvent<T>): Promise<void> {
    const { contractId, payload } = createEvent;

    if (this.relevanceFn && !this.relevanceFn(payload)) {
      this.logger.warn(`Ignoring irrelevant contract`, {
        templateId: this.contractTemplate.templateId,
        contractId: contractId.toString(),
        payload,
      });
      return;
    }

    this.logger.debug(`Contract created`, {
      templateId: this.contractTemplate.templateId,
      contractId: contractId.toString(),
    });

    this.contractMap.set(contractId, createEvent);

    if (!this.firstSeenAtMap.has(contractId)) {
      this.firstSeenAtMap.set(contractId, new Date().toISOString());
    }

    for (const [, callback] of this.createdCallbacks) {
      try {
        await callback(contractId, payload, createEvent);
      } catch (error) {
        this.logger.error(
          `Error executing created callback for ${this.contractTemplate.templateId}`,
          error as Error,
          { contractId: contractId.toString() }
        );
      }
    }
  }

  public async handleContractArchived(contractId: ContractId<T>): Promise<void> {
    this.logger.debug(`Contract archived`, {
      templateId: this.contractTemplate.templateId,
      contractId: contractId.toString(),
    });

    const createEvent = this.contractMap.get(contractId);
    if (createEvent) {
      const payload = createEvent.payload;
      this.contractMap.delete(contractId);
      this.firstSeenAtMap.delete(contractId);

      for (const [, callback] of this.archivedCallbacks) {
        try {
          await callback(contractId, payload);
        } catch (error) {
          this.logger.error(
            `Error executing archived callback for ${this.contractTemplate.templateId}`,
            error as Error,
            { contractId: contractId.toString() }
          );
        }
      }
    }
  }

  public cleanup(): void {
    this.contractMap.clear();
    this.createdCallbacks.clear();
    this.archivedCallbacks.clear();
  }
}
