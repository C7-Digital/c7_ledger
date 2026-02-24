import { ContractId, InterfaceCompanion } from "@daml/types";
import { Interface, PackageIdString } from "@c7-digital/ledger";
import type { InterfaceViewedCallback, InterfaceArchivedCallback, AcsLogger } from "./types.js";

export class InterfaceTracker<I extends object> {
  private interfaceMap = new Map<ContractId<I>, Interface<I>>();
  private viewedCallbacks: Map<string, InterfaceViewedCallback<I>> = new Map();
  private archivedCallbacks: Map<string, InterfaceArchivedCallback<I>> = new Map();
  private contractInterface: InterfaceCompanion<I, any, PackageIdString>;
  private relevanceFn?: (view: I) => boolean;
  private firstSeenAtMap = new Map<ContractId<I>, string>();
  private logger: AcsLogger;

  constructor(
    contractInterface: InterfaceCompanion<I, any, PackageIdString>,
    logger: AcsLogger,
    relevanceFn?: (view: I) => boolean,
  ) {
    this.contractInterface = contractInterface;
    this.logger = logger;
    this.relevanceFn = relevanceFn;
  }

  public getView(contractId: ContractId<I>): I | undefined {
    const interfaceEvent = this.interfaceMap.get(contractId);
    return interfaceEvent?.interfaceView;
  }

  public getInterfaceEvent(contractId: ContractId<I>): Interface<I> | undefined {
    return this.interfaceMap.get(contractId);
  }

  public getAllInterfaces(): Map<ContractId<I>, I> {
    const result = new Map<ContractId<I>, I>();
    for (const [contractId, interfaceEvent] of this.interfaceMap.entries()) {
      result.set(contractId, interfaceEvent.interfaceView);
    }
    return result;
  }

  public getAllInterfaceEvents(): Map<ContractId<I>, Interface<I>> {
    return new Map(this.interfaceMap);
  }

  public getAllInterfacesWithMeta(): Array<{
    contractId: ContractId<I>;
    view: I;
    firstSeenAt: string;
  }> {
    const out: Array<{
      contractId: ContractId<I>;
      view: I;
      firstSeenAt: string;
    }> = [];
    for (const [id, interfaceEvent] of this.interfaceMap.entries()) {
      const ts = this.firstSeenAtMap.get(id) ?? new Date().toISOString();
      out.push({
        contractId: id,
        view: interfaceEvent.interfaceView,
        firstSeenAt: ts,
      });
    }
    return out;
  }

  public hasInterface(contractId: ContractId<I>): boolean {
    return this.interfaceMap.has(contractId);
  }

  public getInterfaceCount(): number {
    return this.interfaceMap.size;
  }

  public getInterfaceId(): PackageIdString {
    return this.contractInterface.templateId;
  }

  public onViewed(key: string, callback: InterfaceViewedCallback<I>): void {
    if (this.viewedCallbacks.has(key)) {
      throw new Error(`Callback with key ${key} already exists`);
    }
    this.viewedCallbacks.set(key, callback);
  }

  public removeViewedCallback(key: string): void {
    this.viewedCallbacks.delete(key);
  }

  public onArchived(key: string, callback: InterfaceArchivedCallback<I>): void {
    if (this.archivedCallbacks.has(key)) {
      throw new Error(`Callback with key ${key} already exists`);
    }
    this.archivedCallbacks.set(key, callback);
  }

  public removeArchivedCallback(key: string): void {
    this.archivedCallbacks.delete(key);
  }

  public async handleInterfaceViewed(interfaceEvent: Interface<I>): Promise<void> {
    const { contractId, interfaceView: view } = interfaceEvent;

    if (this.relevanceFn && !this.relevanceFn(view)) {
      this.logger.warn(`Ignoring irrelevant interface`, {
        interfaceId: this.contractInterface.templateId,
        contractId: contractId.toString(),
        view,
      });
      return;
    }

    this.logger.debug(`Interface viewed`, {
      interfaceId: this.contractInterface.templateId,
      contractId: contractId.toString(),
    });

    this.interfaceMap.set(contractId, interfaceEvent);

    if (!this.firstSeenAtMap.has(contractId)) {
      this.firstSeenAtMap.set(contractId, new Date().toISOString());
    }

    for (const [, callback] of this.viewedCallbacks) {
      try {
        await callback(contractId, view, interfaceEvent);
      } catch (error) {
        this.logger.error(
          `Error executing viewed callback for ${this.contractInterface.templateId}`,
          error as Error,
          { contractId: contractId.toString() }
        );
      }
    }
  }

  public async handleInterfaceArchived(contractId: ContractId<I>): Promise<void> {
    this.logger.debug(`Interface archived`, {
      interfaceId: this.contractInterface.templateId,
      contractId: contractId.toString(),
    });

    const interfaceEvent = this.interfaceMap.get(contractId);
    if (interfaceEvent) {
      const view = interfaceEvent.interfaceView;
      this.interfaceMap.delete(contractId);
      this.firstSeenAtMap.delete(contractId);

      for (const [, callback] of this.archivedCallbacks) {
        try {
          await callback(contractId, view);
        } catch (error) {
          this.logger.error(
            `Error executing archived callback for ${this.contractInterface.templateId}`,
            error as Error,
            { contractId: contractId.toString() }
          );
        }
      }
    }
  }

  public cleanup(): void {
    this.interfaceMap.clear();
    this.viewedCallbacks.clear();
    this.archivedCallbacks.clear();
  }
}
