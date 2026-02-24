import {
  Ledger,
  CreateEvent,
  Interface,
  MultiStream,
  InterfaceMultiStream,
  Stream,
  TemplateMapping,
  InterfaceMapping,
  PackageIdString,
  VersionedRegistry,
} from "@c7-digital/ledger";
import { ContractId, Party, Template, InterfaceCompanion } from "@daml/types";
import { TemplateTracker } from "./templateTracker.js";
import { InterfaceTracker } from "./interfaceTracker.js";
import { TypeSafeTrackerRegistry, TypeSafeInterfaceTrackerRegistry } from "./registries.js";
import type { TrackerRegistry, InterfaceTrackerRegistry, PayloadOf, AcsLogger } from "./types.js";
import { noOpLogger } from "./types.js";

export interface ActiveContractsServiceOptions {
  ledgerUrl?: string;
  versionedRegistry: VersionedRegistry;
  logger?: AcsLogger;
}

export class ActiveContractsService {
  private trackers: TrackerRegistry = new TypeSafeTrackerRegistry();
  private interfaceTrackers: InterfaceTrackerRegistry = new TypeSafeInterfaceTrackerRegistry();
  private multiStream?: MultiStream<any>;
  private interfaceMultiStream?: InterfaceMultiStream<any>;
  private templateMapping: TemplateMapping = {};
  private interfaceMapping: InterfaceMapping = {};
  private ledger?: Ledger;
  private readAsParties: Party[] = [];
  private isInitialized = false;
  private ledgerUrl?: string;
  private hasAcs = false;
  private versionedRegistry: VersionedRegistry;
  private logger: AcsLogger;

  // Strong references to prevent garbage collection
  private activeStreams: Set<Stream<any, any>> = new Set();
  private activeMultiStreams: Set<MultiStream<any>> = new Set();

  constructor(options: ActiveContractsServiceOptions) {
    this.ledgerUrl = options.ledgerUrl;
    this.versionedRegistry = options.versionedRegistry;
    this.logger = options.logger ?? noOpLogger;
  }

  public setLedgerUrl(ledgerUrl: string): void {
    this.ledgerUrl = ledgerUrl;
  }

  public getLedger(): Ledger | undefined {
    return this.ledger;
  }

  public async initWithToken(token: string): Promise<void> {
    if (!this.ledgerUrl) {
      throw new Error("Ledger URL must be set before initializing");
    }

    this.logger.info(`Initializing ActiveContractsService with token`, {
      tokenLength: token?.length || 0,
      ledgerUrl: this.ledgerUrl,
    });

    try {
      await this.cleanupStream();

      const ledgerOptions = {
        token: token,
        httpBaseUrl: this.ledgerUrl.endsWith("/") ? this.ledgerUrl.slice(0, -1) : this.ledgerUrl,
        validation: "logErrors" as const,
        versionedRegistry: this.versionedRegistry,
      };

      this.logger.debug(`Ledger options`, { ledgerOptions });
      this.ledger = new Ledger(ledgerOptions);

      const userInfo = await this.ledger.getTokenUserInfo();
      this.logger.info(`User info`, { userInfo });
      this.readAsParties =
        userInfo?.rights
          ?.filter(right => right.type === "canReadAs" || right.type === "canActAs")
          .map(right => right.party) || [];

      await this.initMultiStream();

      this.isInitialized = true;

      this.logger.info(
        `ActiveContractsService initialized with ${Array.from(this.trackers.keys()).length} contract types`
      );
    } catch (error) {
      this.logger.error(
        `Error initializing ActiveContractsService: ${JSON.stringify(error)}`,
        error as Error
      );
      throw error;
    }
  }

  public getTracker<T extends Template<any, any, any>>(
    contractTemplate: T
  ): TemplateTracker<PayloadOf<T>> {
    const templateId = contractTemplate.templateId as PackageIdString;
    const tracker = this.trackers.get(templateId) as TemplateTracker<PayloadOf<T>> | undefined;

    if (!tracker) {
      throw new Error(
        `Contract type ${templateId} is not registered. ` +
          `Use registerTemplate before trying to access the tracker.`
      );
    }

    return tracker;
  }

  public registerTemplate<T extends Template<any, any, any>>(
    contractTemplate: T,
    relevanceFn?: (payload: PayloadOf<T>) => boolean
  ): TemplateTracker<PayloadOf<T>> {
    if (this.isInitialized) {
      throw new Error(
        `Cannot register template ${contractTemplate.templateId} after initialization. ` +
          `Register all templates before calling initWithToken.`
      );
    }

    const templateId = contractTemplate.templateId as PackageIdString;

    if (this.trackers.has(templateId)) {
      throw new Error(`Template ${templateId} is already registered`);
    }

    const tracker = new TemplateTracker<PayloadOf<T>>(contractTemplate, this.logger, relevanceFn);
    this.trackers.set(templateId, tracker);

    this.templateMapping[templateId] = {
      contractType: {} as T,
      keyType: undefined,
    };

    this.logger.debug(`Registered template ${templateId}`);
    return tracker;
  }

  public registerInterface<I extends InterfaceCompanion<any, any, any>>(
    contractInterface: I,
    relevanceFn?: (view: PayloadOf<I>) => boolean
  ): InterfaceTracker<PayloadOf<I>> {
    if (this.isInitialized) {
      throw new Error(
        `Cannot register interface ${contractInterface.templateId} after initialization. ` +
          `Register all interfaces before calling initWithToken.`
      );
    }

    const interfaceId = contractInterface.templateId as PackageIdString;

    if (this.interfaceTrackers.has(interfaceId)) {
      throw new Error(`Interface ${interfaceId} is already registered`);
    }

    const tracker = new InterfaceTracker<PayloadOf<I>>(contractInterface, this.logger, relevanceFn);
    this.interfaceTrackers.set(interfaceId, tracker);

    this.interfaceMapping[interfaceId] = {
      contractType: {} as PayloadOf<I>,
    };

    this.logger.debug(`Registered interface ${interfaceId}`);
    return tracker;
  }

  public getInterfaceTracker<I extends InterfaceCompanion<any, any, any>>(
    contractInterface: I
  ): InterfaceTracker<PayloadOf<I>> {
    const interfaceId = contractInterface.templateId as PackageIdString;
    const tracker = this.interfaceTrackers.get(interfaceId) as InterfaceTracker<PayloadOf<I>> | undefined;

    if (!tracker) {
      throw new Error(
        `Interface type ${interfaceId} is not registered. ` +
          `Use registerInterface before trying to access the tracker.`
      );
    }

    return tracker;
  }

  private async initMultiStream(): Promise<void> {
    if (!this.ledger) {
      throw new Error("Ledger must be initialized before calling initMultiStream");
    }

    this.logger.info(`Initializing MultiStream for ${this.trackers.length()} templates`);

    try {
      this.multiStream = await this.ledger.createMultiStream<TemplateMapping>(
        this.templateMapping,
        "end",
        this.hasAcs,
        false,
        this.readAsParties
      );

      // Add to strong reference set to prevent garbage collection
      this.activeMultiStreams.add(this.multiStream);

      this.multiStream.onState(state => {
        this.logger.info(`MultiStream state: ${state}`);
        if (state === "live") {
          this.hasAcs = true;
        }
      });

      for (const templateId of this.trackers.keys()) {
        const tracker = this.trackers.get(templateId)!;

        this.multiStream.onCreate(templateId, event => {
          tracker.handleContractCreated(event);
        });

        this.multiStream.onArchive(templateId, event => {
          tracker.handleContractArchived(event.contractId);
        });
      }

      this.multiStream.onError(error => {
        this.logger.error(`MultiStream error: ${JSON.stringify(error)}`);
      });

      this.multiStream.start();

      this.logger.info(`Started MultiStream for ${this.trackers.length()} templates`);

      if (this.interfaceTrackers.length() > 0) {
        await this.initInterfaceMultiStream();
      }
    } catch (error) {
      this.logger.error(`Error initializing MultiStream`, error as Error);
      throw error;
    }
  }

  private async initInterfaceMultiStream(): Promise<void> {
    if (!this.ledger) {
      throw new Error("Ledger must be initialized before calling initInterfaceMultiStream");
    }

    this.logger.info(`Initializing InterfaceMultiStream for ${this.interfaceTrackers.length()} interfaces`);

    try {
      this.interfaceMultiStream = await this.ledger.createMultiInterfaceStream<InterfaceMapping>(
        this.interfaceMapping,
        "end",
        this.hasAcs,
        false,
        this.readAsParties
      );

      this.interfaceMultiStream.onState(state => {
        this.logger.info(`InterfaceMultiStream state: ${state}`);
        if (state === "live") {
          this.hasAcs = true;
        }
      });

      for (const interfaceId of this.interfaceTrackers.keys()) {
        const tracker = this.interfaceTrackers.get(interfaceId)!;

        this.interfaceMultiStream.onInterfaceView(interfaceId, event => {
          tracker.handleInterfaceViewed(event);
        });

        this.interfaceMultiStream.onArchive(interfaceId, event => {
          tracker.handleInterfaceArchived(event.contractId);
        });
      }

      this.interfaceMultiStream.onError(error => {
        this.logger.error(`InterfaceMultiStream error: ${JSON.stringify(error)}`);
      });

      this.interfaceMultiStream.start();

      this.logger.info(`Started InterfaceMultiStream for ${this.interfaceTrackers.length()} interfaces`);
    } catch (error) {
      this.logger.error(`Error initializing InterfaceMultiStream`, error as Error);
      throw error;
    }
  }

  // Convenience methods
  public getPayload<T extends Template<any, any, any>>(
    contractTemplate: T,
    contractId: ContractId<PayloadOf<T>>
  ): PayloadOf<T> | undefined {
    const tracker = this.getTracker(contractTemplate);
    return tracker.getPayload(contractId);
  }

  public getAllPayloads<T extends Template<any, any, any>>(
    contractTemplate: T
  ): Map<ContractId<PayloadOf<T>>, PayloadOf<T>> | undefined {
    const tracker = this.getTracker(contractTemplate);
    return tracker.getAllContracts();
  }

  public getContractCount(contractTemplate: Template<any, any, any>): number {
    const tracker = this.getTracker(contractTemplate);
    return tracker.getContractCount();
  }

  public getAllCreateEvents<T extends Template<any, any, any>>(
    contractTemplate: T
  ): Map<ContractId<T>, CreateEvent<PayloadOf<T>>> {
    const tracker = this.getTracker(contractTemplate);
    return tracker.getAllCreateEvents();
  }

  public getIsInitialized(): boolean {
    return this.isInitialized;
  }

  public getRegisteredContractTypes(): PackageIdString[] {
    return Array.from(this.trackers.keys());
  }

  // Interface convenience methods
  public getInterfaceView<I extends InterfaceCompanion<any, any, any>>(
    contractInterface: I,
    contractId: ContractId<PayloadOf<I>>
  ): PayloadOf<I> | undefined {
    const tracker = this.getInterfaceTracker(contractInterface);
    return tracker.getView(contractId);
  }

  public getAllInterfaceViews<I extends InterfaceCompanion<any, any, any>>(
    contractInterface: I
  ): Map<ContractId<PayloadOf<I>>, PayloadOf<I>> | undefined {
    const tracker = this.getInterfaceTracker(contractInterface);
    return tracker.getAllInterfaces();
  }

  public getInterfaceCount<I extends InterfaceCompanion<any, any, any>>(contractInterface: I): number {
    const tracker = this.getInterfaceTracker(contractInterface);
    return tracker.getInterfaceCount();
  }

  public getAllInterfaceEvents<I extends InterfaceCompanion<any, any, any>>(
    contractInterface: I
  ): Map<ContractId<PayloadOf<I>>, Interface<PayloadOf<I>>> {
    const tracker = this.getInterfaceTracker(contractInterface);
    return tracker.getAllInterfaceEvents();
  }

  public getRegisteredInterfaceTypes(): PackageIdString[] {
    return Array.from(this.interfaceTrackers.keys());
  }

  /**
   * Add a stream to the strong reference tracking to prevent garbage collection.
   * Use this when creating individual streams outside of the main MultiStream.
   */
  public addStreamReference(stream: Stream<any, any>): void {
    this.activeStreams.add(stream);
    this.logger.debug(`Added stream reference, total active streams: ${this.activeStreams.size}`);
  }

  /**
   * Remove a stream from strong reference tracking (usually when it's manually closed).
   */
  public removeStreamReference(stream: Stream<any, any>): void {
    const removed = this.activeStreams.delete(stream);
    if (removed) {
      this.logger.debug(`Removed stream reference, total active streams: ${this.activeStreams.size}`);
    }
  }

  public async cleanupStream(): Promise<void> {
    this.logger.info("Cleaning up ActiveContractsService");

    if (this.multiStream) {
      this.multiStream.close();
      this.activeMultiStreams.delete(this.multiStream);
      this.multiStream = undefined;
    }

    if (this.interfaceMultiStream) {
      this.interfaceMultiStream.close();
      this.interfaceMultiStream = undefined;
    }

    // Clean up all active streams
    for (const stream of this.activeStreams) {
      try {
        stream.close();
      } catch (error) {
        this.logger.warn("Error closing stream during cleanup", error as any);
      }
    }
    this.activeStreams.clear();

    // Clean up all active multi-streams
    for (const multiStream of this.activeMultiStreams) {
      try {
        multiStream.close();
      } catch (error) {
        this.logger.warn("Error closing multi-stream during cleanup", error as any);
      }
    }
    this.activeMultiStreams.clear();

    // Do NOT clean up tracker state as they retain state across token changes
    this.isInitialized = false;
    this.ledger = undefined;
  }
}
