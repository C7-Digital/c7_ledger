import { ContractId, InterfaceCompanion } from "@daml/types";
import { Interface, PackageIdString } from "@c7-digital/ledger";
import type { InterfaceViewedCallback, InterfaceArchivedCallback, AcsLogger } from "./types.js";
import { BaseTracker } from "./baseTracker.js";

export class InterfaceTracker<I extends object> extends BaseTracker<I, Interface<I>> {
  constructor(
    contractInterface: InterfaceCompanion<I, any, PackageIdString>,
    logger: AcsLogger,
    relevanceFn?: (view: I) => boolean,
  ) {
    super(
      {
        identifier: contractInterface.templateId,
        entityLabel: "interface",
        idLabel: "interfaceId",
        addedVerb: "viewed",
        dataLabel: "view",
      },
      logger,
      relevanceFn,
    );
  }

  protected extractData(event: Interface<I>): I {
    return event.interfaceView;
  }

  protected extractContractId(event: Interface<I>): ContractId<I> {
    return event.contractId;
  }

  public getView(contractId: ContractId<I>): I | undefined {
    return this.getDataByContractId(contractId);
  }

  public getInterfaceEvent(contractId: ContractId<I>): Interface<I> | undefined {
    return this.getEventByContractId(contractId);
  }

  public getAllInterfaces(): Map<ContractId<I>, I> {
    return this.getAllDataEntries();
  }

  public getAllInterfaceEvents(): Map<ContractId<I>, Interface<I>> {
    return this.getAllEventEntries();
  }

  public getAllInterfacesWithMeta(): Array<{
    contractId: ContractId<I>;
    view: I;
    firstSeenAt: string;
  }> {
    return this.getAllEntriesWithMeta().map(({ contractId, data, firstSeenAt }) => ({
      contractId,
      view: data,
      firstSeenAt,
    }));
  }

  public hasInterface(contractId: ContractId<I>): boolean {
    return this.hasEntry(contractId);
  }

  public getInterfaceCount(): number {
    return this.getEntryCount();
  }

  public getInterfaceId(): PackageIdString {
    return this.getIdentifier();
  }

  public onViewed(key: string, callback: InterfaceViewedCallback<I>): void {
    this.registerAddedCallback(key, callback);
  }

  public removeViewedCallback(key: string): void {
    this.removeAddedCallback(key);
  }

  public onArchived(key: string, callback: InterfaceArchivedCallback<I>): void {
    this.registerArchivedCallback(key, callback);
  }

  public removeArchivedCallback(key: string): void {
    this.removeRegisteredArchivedCallback(key);
  }

  public async handleInterfaceViewed(interfaceEvent: Interface<I>): Promise<void> {
    return this.handleEventAdded(interfaceEvent);
  }

  public async handleInterfaceArchived(contractId: ContractId<I>): Promise<void> {
    return this.handleEventArchived(contractId);
  }
}
