import { ContractId, Template } from "@daml/types";
import { CreateEvent, PackageIdString } from "@c7-digital/ledger";
import type { ContractCreatedCallback, ContractArchivedCallback, AcsLogger } from "./types.js";
import { BaseTracker } from "./baseTracker.js";

export class TemplateTracker<T extends object> extends BaseTracker<T, CreateEvent<T>> {
  constructor(
    contractTemplate: Template<T, any, PackageIdString>,
    logger: AcsLogger,
    relevanceFn?: (payload: T) => boolean,
  ) {
    super(
      {
        identifier: contractTemplate.templateId,
        entityLabel: "contract",
        idLabel: "templateId",
        addedVerb: "created",
        dataLabel: "payload",
      },
      logger,
      relevanceFn,
    );
  }

  protected extractData(event: CreateEvent<T>): T {
    return event.payload;
  }

  protected extractContractId(event: CreateEvent<T>): ContractId<T> {
    return event.contractId;
  }

  public getPayload(contractId: ContractId<T>): T | undefined {
    return this.getDataByContractId(contractId);
  }

  public getCreateEvent(contractId: ContractId<T>): CreateEvent<T> | undefined {
    return this.getEventByContractId(contractId);
  }

  public getAllContracts(): Map<ContractId<T>, T> {
    return this.getAllDataEntries();
  }

  public getAllCreateEvents(): Map<ContractId<T>, CreateEvent<T>> {
    return this.getAllEventEntries();
  }

  public getAllContractsWithMeta(): Array<{
    contractId: ContractId<T>;
    payload: T;
    firstSeenAt: string;
  }> {
    return this.getAllEntriesWithMeta().map(({ contractId, data, firstSeenAt }) => ({
      contractId,
      payload: data,
      firstSeenAt,
    }));
  }

  public hasContract(contractId: ContractId<T>): boolean {
    return this.hasEntry(contractId);
  }

  public getContractCount(): number {
    return this.getEntryCount();
  }

  public getTemplateId(): PackageIdString {
    return this.getIdentifier();
  }

  public onCreated(key: string, callback: ContractCreatedCallback<T>): void {
    this.registerAddedCallback(key, callback);
  }

  public removeCreatedCallback(key: string): void {
    this.removeAddedCallback(key);
  }

  public onArchived(key: string, callback: ContractArchivedCallback<T>): void {
    this.registerArchivedCallback(key, callback);
  }

  public removeArchivedCallback(key: string): void {
    this.removeRegisteredArchivedCallback(key);
  }

  public async handleContractCreated(createEvent: CreateEvent<T>): Promise<void> {
    return this.handleEventAdded(createEvent);
  }

  public async handleContractArchived(contractId: ContractId<T>): Promise<void> {
    return this.handleEventArchived(contractId);
  }
}
