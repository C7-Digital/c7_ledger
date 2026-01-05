/**
 * High-level Daml Ledger abstraction for Canton's OpenAPI v2 JSON API
 *
 * This class provides convenient, Template and Choice-aware methods for common
 * Daml operations. It applies business logic to filter and transform raw API
 * responses into the expected Daml types, ensuring results match the requested
 * Template or Choice specifications.
 *
 * Key features:
 * - Template-typed contract queries and creation
 * - Choice-typed exercise operations
 * - Automatic filtering of irrelevant data (non-active contracts, wrong templates)
 * - Type safety with branded value.proto string types
 * - Compatibility with @daml/types interfaces
 *
 * Use this for most Daml application needs. Use TypedHttpClient directly when
 * you need access to Canton-specific endpoints or full control over API calls.
 */
import {
  ContractId,
  Party,
  Choice,
  InterfaceCompanion,
  Template,
  lookupTemplate,
} from "@daml/types";
import { EventEmitter } from "eventemitter3";
import { logger } from "./logger";
import { logTokenExpiration } from "./token";
import { components } from "./generated/api";
import { TypedHttpClient } from "./client";
import {
  WebSocketClient,
  ActiveContractsStreamRequest,
  ActiveContractsResponse,
  UpdatesResponse,
  isTransaction,
} from "./websocket";
import { MultiStreamAdapter, InterfaceMultiStreamImpl } from "./multistream";
import {
  AllocatePartyRequest,
  AllocatePartyResponse,
  ArchiveEvent,
  CantonError,
  Command,
  CreateCommand,
  CreateAndExerciseCommand,
  CreateEvent,
  ExerciseCommand,
  Event,
  Interface,
  LedgerOffset,
  Stream,
  InterfaceStream,
  InterfaceMapping,
  InterfaceMultiStream,
  StreamState,
  PartyDetails,
  User,
  StreamCloseEvent,
  MultiStream,
  TemplateMapping,
  VersionedRegistry,
} from "./types";
import { matchesPartiallyQualified } from "./util";
import { ValidationMode } from "./validation";
import * as translate from "./translate";
import {
  createLedgerString,
  createPartyIdString,
  createNameString,
  createUserIdString,
  LedgerString,
  PackageIdString,
  NameString,
} from "./valueTypes";

type Filters = components["schemas"]["Filters"];
type JsCommands = Schemas["JsCommands"];
type JsCommand = Schemas["Command"];
type Schemas = components["schemas"];
type CreatedEvent = Schemas["CreatedEvent"];
type ArchivedEvent = Schemas["ArchivedEvent"];
type JsInterfaceView = Schemas["JsInterfaceView"];

// Type guard to check if an event is a CreatedEvent
function isCreateEvent(
  event: Schemas["Event"]
): event is { CreatedEvent: Schemas["CreatedEvent"] } {
  return "CreatedEvent" in event;
}

function createEventWithoutDecoder(
  cantonEvent: CreatedEvent,
): CreateEvent<object, unknown> {
   return {
    type: "create",
    templateId: cantonEvent.templateId,
    contractId: cantonEvent.contractId as unknown as ContractId<object>,
    payload: cantonEvent.createArgument ?? {},
    signatories: (cantonEvent.signatories || []) as Party[],
    observers: (cantonEvent.observers || []) as Party[],
    key: undefined,
    createdEventBlob: cantonEvent.createdEventBlob || "",
  };
}

// This term is so overloaded, lets add a '_' to help differentiate
function createEvent_<T extends object, K = unknown>(
  cantonEvent: CreatedEvent,
  versionedRegistry?: VersionedRegistry
): CreateEvent<T, K> {
  let t: Template<T, K>;
  let packageVersion: string | undefined;

  // Use custom registry if provided, otherwise fall back to default lookupTemplate
  if (versionedRegistry) {
    const result = versionedRegistry(cantonEvent.templateId);

    if (!result) {
      throw new Error(`Template not found in registry: ${cantonEvent.templateId}`);
    }

    // Check if result is a tuple [Template, version] or just Template
    if (result.type === "template") {
      const { template, version} = result;
      t = template as unknown as Template<T, K>;
      packageVersion = version;
    } else {
      throw new Error(`Expected template in registry not: ${JSON.stringify(result)}`);
    }
  } else {
    t = lookupTemplate(cantonEvent.templateId) as unknown as Template<T, K>;
  }

  return {
    type: "create",
    templateId: cantonEvent.templateId,
    contractId: cantonEvent.contractId as unknown as ContractId<T>,
    payload: t.decoder.runWithException(cantonEvent.createArgument) as T,
    signatories: (cantonEvent.signatories || []) as Party[],
    observers: (cantonEvent.observers || []) as Party[],
    key: cantonEvent.contractKey
      ? (t.keyDecoder?.runWithException(cantonEvent.contractKey) as K)
      : undefined,
    createdEventBlob: cantonEvent.createdEventBlob || "",
    packageVersion,
  };
}

function archiveEvent_<T extends object>(cantonEvent: ArchivedEvent): ArchiveEvent<T> {
  return {
    type: "archive",
    templateId: cantonEvent.templateId,
    contractId: cantonEvent.contractId as unknown as ContractId<T>,
    witnessParties: (cantonEvent.witnessParties || []) as Party[],
    offset: cantonEvent.offset,
  };
}

// It is possible that we query for a given interview that we are interested in,
// but the underlying contract has multiple interview implementations that we are NOT
// interested in, and consequently not registered in our versionedRegistry.
// In this case we return null.
function interfaceEvent_<I extends object, K = unknown>(
  cantonEvent: CreatedEvent,
  interfaceView: JsInterfaceView, 
  versionedRegistry: VersionedRegistry
): Interface<I> | null{

  const result = versionedRegistry(interfaceView.interfaceId);

  if (!result) {
    logger.warn(`Interface not found in registry: ${interfaceView.interfaceId}`);
    return null;
  }

  if (result.type === "template") {
    throw new Error(`Expected template in registry not: ${JSON.stringify(result)}`);
  }
  const { interface_, version} = result;
  const i = interface_ as unknown as InterfaceCompanion<I, K>;
  const decodedInterfaceView = i.decoder.runWithException(interfaceView.viewValue);
  const packageVersion = version;

  return {
    type: "interface",
    templateId: cantonEvent.templateId,
    contractId: cantonEvent.contractId as unknown as ContractId<I>,
    payload: cantonEvent.createArgument,
    signatories: (cantonEvent.signatories || []) as Party[],
    observers: (cantonEvent.observers || []) as Party[],
    key: cantonEvent.contractKey,
    createdEventBlob: cantonEvent.createdEventBlob || "",
    interfaceView: decodedInterfaceView,
    packageVersion,
  }
}

type IdentifierFilter = components["schemas"]["IdentifierFilter"];
function templateFilter(
  templateId: PackageIdString,
  includeCreatedEventBlob: boolean
): IdentifierFilter {
  return {
    TemplateFilter: {
      value: {
        templateId: templateId,
        includeCreatedEventBlob,
      },
    },
  };
}

function interfaceFilter(
  interfaceId: PackageIdString,
  includeCreatedEventBlob: boolean
): IdentifierFilter {
  return {
    InterfaceFilter: {
      value: {
        interfaceId: interfaceId,
        includeInterfaceView: true,
        includeCreatedEventBlob,
      },
    },
  };
}

// Convenience constructors for commands
export function createCmd<T extends object, K = unknown>(template: Template<T, K, string>, payload: T): CreateCommand<T, K> {
  return {
    type: 'create',
    template,
    payload,
  };
}

export function createAndExerciseCmd<T extends object, C, R, K = unknown>(
  template: Template<T, K, string>,
  payload: T,
  choice: Choice<T, C, R, K>,
  argument: C
): CreateAndExerciseCommand<T, C, R, K> {
  return {
    type: 'createAndExercise',
    template,
    payload,
    choice,
    argument,
  };
}

export function exerciseCmd<T extends object, C, R, K = unknown>(
  contractId: ContractId<T>,
  choice: Choice<T, C, R, K>,
  argument: C
): ExerciseCommand<T, C, R, K> {
  return {
    type: 'exercise',
    contractId,
    choice,
    argument,
  };
}

function convertCommand(command: Command<any, any>) : JsCommand {
  switch (command.type) {
    case 'create':
      return {
        CreateCommand: {
          templateId: command.template.templateId,
          createArguments: command.payload,
        }
      };
    case 'createAndExercise':
      return {
        CreateAndExerciseCommand: {
          templateId: command.template.templateId,
          createArguments: command.payload,
          choice: createNameString(command.choice.choiceName),
          choiceArgument: command.argument,
        }
      };
    case 'exercise':
      return {
        ExerciseCommand: {
          templateId: command.choice.template().templateId,
          contractId: createLedgerString(command.contractId),
          choice: createNameString(command.choice.choiceName),
          choiceArgument: command.argument,
        }
      };
    default:
      // TypeScript exhaustiveness check
      const _exhaustive: never = command;
      throw new Error(`Unknown command type: ${JSON.stringify(_exhaustive)}`);
  }
}

/**
 * Options for the Ledger constructor
 */
export interface LedgerOptions {
  /**
   * The authentication token to use for requests
   */
  token: string;
  /**
   * The base URL for HTTP requests.
   */
  httpBaseUrl: string;
  /**
   * The base URL for WebSocket requests, derived from httpBaseUrl if not provided.
   */
  wsBaseUrl?: string;
  /**
   * The validation mode to use for requests.
   * "throwOnError" - throw an error if validation fails
   * "logErrors" - log errors to console/logger if validation fails
   *
   * The API does fail validation pretty frequently so even with "logErrors"
   * please be prepared for some noise in the logger.
   */
  validation?: ValidationMode;
  /**
   * The path to the OpenAPI schema to use for validation
   */
  openApiSchemaPath?: string;
  /**
   * The path to the AsyncAPI schema to use for validation
   */
  asyncApiSchemaPath?: string;
  /**
   * Semi-optional version-aware template/interface registry.
   * If provided, this function will be used instead of the default lookupTemplate.
   * Should return VersionedLookupResult or undefined. This is required for
   * querying and decoding interfaces views.
   */
  versionedRegistry?: VersionedRegistry;
  /**
   * Whether to automatically reconnect WebSocket streams on abnormal close (1006).
   * Defaults to true for backward compatibility.
   */
  autoReconnect?: boolean;
}

type FilterSpec 
  = { type: "template", templateId: PackageIdString } 
  | { type: "interface", interfaceId: PackageIdString };

/**
 * Internal stream implementation for active contracts
 */
class LedgerStream<T extends object, K = unknown> implements Stream<T, K> {
  protected eventEmitter = new EventEmitter();
  private stopClient?: () => void;
  private parties: Party[];
  private wsClient: WebSocketClient;
  private offset: number;
  private skipAcs: boolean;
  private state_: StreamState = "start";
  private filtersByParty: Record<string, any>;
  protected versionedRegistry?: VersionedRegistry;
  private autoReconnect: boolean;

  /**
   * Creates a new stream for active contracts
   *
   * @param filters The filters to stream contracts for - FilterSpec[]
   * @param parties The parties to stream contracts for
   * @param wsClient The WebSocket client to use
   * @param activeAtOffset Optional offset to start streaming from
   */
  constructor(
    filters: FilterSpec[],
    parties: Party[],
    wsClient: WebSocketClient,
    startOffset: number,
    skipAcs: boolean = false,
    includeCreatedEventBlob: boolean = true,
    versionedRegistry?: VersionedRegistry,
    autoReconnect: boolean = false,
  ) {
    this.parties = parties;
    this.wsClient = wsClient;
    this.offset = startOffset;
    this.skipAcs = skipAcs;
    this.versionedRegistry = versionedRegistry;
    this.autoReconnect = autoReconnect;
    let cumulative = filters.map(filter => {
      return {
        identifierFilter: filter.type === "template" 
          ? templateFilter(filter.templateId, includeCreatedEventBlob) 
          : interfaceFilter(filter.interfaceId, includeCreatedEventBlob),
      };
    });
    this.filtersByParty = this.parties.reduce(
      (acc, party) => {
        acc[party] = { cumulative };
        return acc;
      },
      {} as Record<string, any>
    );
  }

  /**
   * Start the active contracts stream to get existing contracts
   */
  private startActiveContractsStream(): void {
    // Create the request for active contracts
    const request: ActiveContractsStreamRequest = {
      verbose: false,
      activeAtOffset: this.offset,
      eventFormat: {
        filtersByParty: this.filtersByParty,
        verbose: true,
      },
    };

    logger.debug(`Starting active contracts stream from offset ${this.offset}`);

    // Start streaming and store the stop function
    this.stopClient = this.wsClient.streamActiveContracts(
      request,
      response => this.handleActiveContractsResponse(response),
      error => this.handleError(error),
      (code, reason) => this.handleActiveContractsClose(code, reason)
    );
  }

  protected handleCreatedEvent(createdEvent: CreatedEvent): void {
    this.eventEmitter.emit("create", createEvent_(createdEvent, this.versionedRegistry));
  }

  protected handleArchivedEvent(archivedEvent: ArchivedEvent): void {
    this.eventEmitter.emit("archive", archiveEvent_(archivedEvent))
  }

  /**
   * Handle responses from the active contracts stream
   */
  private handleActiveContractsResponse(response: ActiveContractsResponse): void {
    if (response.status === "error") {
      this.eventEmitter.emit("error", response.error);
      return;
    }

    // Process the successful response
    const contractEntry = response.data.contractEntry;

    // Track the offset for continuing with updates stream later
    // Extract offset from the active contract if available
    if (contractEntry && "JsActiveContract" in contractEntry) {
      const activeContract = contractEntry.JsActiveContract;
      // TODO, do we have to do this?
      if (activeContract.createdEvent.offset > this.offset) {
        logger.warn(
          `While receiving ACS, updating offset from ${this.offset} to ${activeContract.createdEvent.offset}`
        );
        this.offset = activeContract.createdEvent.offset;
      }
      this.handleCreatedEvent(activeContract.createdEvent)
    }
  }

  /**
   * Handle close event from active contracts stream
   * This is the signal to transition to the updates stream
   */
  private handleActiveContractsClose(code: number, reason: string): void {
    logger.debug(`Active contracts stream closed: ${code} ${reason}`);

    this.stopClient?.();
    this.stopClient = undefined;

    if (this.state_ === "init") {
      this.state_ = "live";
      this.eventEmitter.emit("state", "live");
      this.startUpdatesStream();
    } else {
      const closeEvent: StreamCloseEvent = { code, reason };
      this.eventEmitter.emit("close", closeEvent);
    }
  }

  /**
   * Start streaming updates after active contracts have been loaded
   */
  private startUpdatesStream(): void {
    // Create the request for updates stream
    const request = {
      beginExclusive: this.offset,
      verbose: false,
      updateFormat: {
        includeTransactions: {
          eventFormat: {
            filtersByParty: this.filtersByParty,
            verbose: true,
          },
          transactionShape: "TRANSACTION_SHAPE_ACS_DELTA" as const,
        },
      },
    };

    logger.debug(`Starting updates stream from offset ${this.offset}`);

    // Start streaming updates and store the stop function
    this.stopClient = this.wsClient.streamUpdates(
      request,
      response => this.handleUpdatesResponse(response),
      error => this.handleError(error),
      (code, reason) => this.handleUpdatesClose(code, reason)
    );
  }

  /**
   * Handle responses from the updates stream
   */
  private handleUpdatesResponse(response: UpdatesResponse): void {
    if (response.status === "error") {
      this.eventEmitter.emit("error", response.error);
      return;
    }
    const update = response.data.update;
    if (isTransaction(update)) {
      const jsTransaction = update.Transaction.value;
      for (const event of jsTransaction.events || []) {
        if ("CreatedEvent" in event) {
          this.offset = Math.max(this.offset, event.CreatedEvent.offset);
          this.handleCreatedEvent(event.CreatedEvent)
        } else if ("ArchivedEvent" in event) {
          this.offset = Math.max(this.offset, event.ArchivedEvent.offset);
          this.handleArchivedEvent(event.ArchivedEvent)
        } else {
          logger.warn(`Unexpected event type in transaction stream: ${JSON.stringify(event)}`);
        }
      }
    } else {
      logger.debug(`Ignoring update of type ${JSON.stringify(update)}`);
    }
  }

  /**
   * Handle close event from updates stream
   */
  private handleUpdatesClose(code: number, reason: string): void {
    logger.debug(`Updates stream closed: ${code} ${reason}`);
    this.stopClient?.();
    this.stopClient = undefined;

    // Emit close event
    const closeEvent: StreamCloseEvent = { code, reason };
    this.eventEmitter.emit("close", closeEvent);

    // Auto-reconnect on abnormal close (1006) if stream is still active and auto-reconnect is enabled
    if (code === 1006 && this.state_ === "live" && this.autoReconnect) {
      logger.log(`WebSocket closed abnormally (1006), reconnecting in 3 seconds...`);
      setTimeout(() => {
        if (this.state_ === "live") {
          // Double-check we're still active
          logger.log(`Attempting to reconnect stream...`);
          // Log token expiration info before reconnection attempt
          logTokenExpiration(this.wsClient.getToken(), "WebSocket reconnection attempt");
          this.startUpdatesStream();
        }
      }, 3000);
    } else if (code === 1006 && this.state_ === "live" && !this.autoReconnect) {
      logger.log(`WebSocket closed abnormally (1006), but auto-reconnect is disabled`);
    }
  }

  // This is a websocket error, not a Canton error
  private handleError(error: Error): void {
    logger.error("Stream error:", error);
    this.eventEmitter.emit("error", {
      code: "STREAM_ERROR",
      cause: error.message,
      context: {},
      errorCategory: 0,
    });
  }

  // Method overload signatures
  on(type: "create", listener: (event: CreateEvent<T, K>) => void): void;
  on(type: "archive", listener: (event: ArchiveEvent<T>) => void): void;
  on(type: "error", listener: (event: CantonError) => void): void;
  on(type: "state", listener: (event: StreamState) => void): void;

  // Implementation
  on(type: string, listener: (...args: any[]) => void): void {
    this.eventEmitter.on(type, listener);
  }

  // Method overload signatures
  off(type: "create", listener: (event: CreateEvent<T, K>) => void): void;
  off(type: "archive", listener: (event: ArchiveEvent<T>) => void): void;
  off(type: "error", listener: (event: CantonError) => void): void;
  off(type: "state", listener: (event: StreamState) => void): void;

  // Implementation
  off(type: string, listener: (...args: any[]) => void): void {
    this.eventEmitter.off(type, listener);
  }

  /**
   * Start streaming contracts
   * First loads active contracts, then transitions to streaming updates
   */
  public start(): void {
    if (this.state_ !== "start") {
      logger.warn(`Cannot start stream in state: ${this.state_}`);
      return;
    }

    if (this.skipAcs) {
      this.state_ = "live";
      this.eventEmitter.emit("state", "live");
      this.startUpdatesStream();
    } else {
      this.state_ = "init";
      this.eventEmitter.emit("state", "init");
      this.startActiveContractsStream();
    }
  }

  public state(): StreamState {
    return this.state_;
  }

  /**
   * Close the stream and clean up resources
   */
  public close(): void {
    // Set state to stop to prevent transitions
    this.state_ = "stop";
    this.eventEmitter.emit("state", "stop");

    if (this.stopClient) {
      this.stopClient();
      this.stopClient = undefined;
    }

    // Clean up event listeners
    this.eventEmitter.removeAllListeners();
  }

  /**
   * Update the authentication token and restart the stream
   */
  public updateToken(newToken: string): void {
    logger.debug(`🔄 Stream token update requested for state: ${this.state_}`);
    logTokenExpiration(newToken, "Stream updateToken()");

    // Update the token in the WebSocket client
    this.wsClient.setToken(newToken);
    logger.debug("WebSocket client token updated");

    // Handle token update based on current stream state
    switch (this.state_) {
      case "live":
        logger.debug(`Restarting live stream with new token`);
        
        // Close current connection
        if (this.stopClient) {
          this.stopClient();
          this.stopClient = undefined;
        }
        
        // Restart the updates stream with the new token
        this.startUpdatesStream();
        break;
        
      case "init":
        logger.debug(`Stream is in init state, will use new token when transitioning to live`);
        // Stream is still in ACS phase, new token will be used when it transitions to updates
        break;
        
      case "start":
        logger.debug(`Stream is in start state, token updated but no restart needed`);
        break;
        
      case "stop":
        logger.debug(`Stream is stopped, token updated but no restart needed`);
        break;
        
      default:
        // TypeScript exhaustiveness check
        const _exhaustive: never = this.state_;
        throw new Error(`Unknown stream state: ${_exhaustive}`);
    }
  }
}

class InterfaceStreamImpl<I extends object> extends LedgerStream<object, unknown> implements InterfaceStream<I> {

  constructor(
    filters: FilterSpec[],
    parties: Party[],
    wsClient: WebSocketClient,
    startOffset: number,
    // Required for interface streams
    versionedRegistry: VersionedRegistry,
    skipAcs: boolean = false,
    includeCreatedEventBlob: boolean = true,
    autoReconnect: boolean = false,
  ) {
    super(filters, parties, wsClient, startOffset, skipAcs, includeCreatedEventBlob, versionedRegistry, autoReconnect);
  }

  // Override on method to handle interfaceView events
  on(type: "create", listener: (event: CreateEvent<object, unknown>) => void): void;
  on(type: "archive", listener: (event: ArchiveEvent<object>) => void): void;
  on(type: "error", listener: (event: CantonError) => void): void;
  on(type: "state", listener: (event: StreamState) => void): void;
  on(type: "interfaceView", listener: (event: Interface<I>) => void): void;
  on(type: string, listener: (...args: any[]) => void): void {
    this.eventEmitter.on(type, listener);
  }

  // Override off method to handle interfaceView events
  off(type: "create", listener: (event: CreateEvent<object, unknown>) => void): void;
  off(type: "archive", listener: (event: ArchiveEvent<object>) => void): void;
  off(type: "error", listener: (event: CantonError) => void): void;
  off(type: "state", listener: (event: StreamState) => void): void;
  off(type: "interfaceView", listener: (event: Interface<I>) => void): void;
  off(type: string, listener: (...args: any[]) => void): void {
    this.eventEmitter.off(type, listener);
  }

  protected handleCreatedEvent(createdEvent: CreatedEvent): void {
    this.eventEmitter.emit("create", createEventWithoutDecoder(createdEvent));
    for (const interfaceView of createdEvent.interfaceViews ?? []) {
      this.eventEmitter.emit("interfaceView", interfaceEvent_(createdEvent, interfaceView, this.versionedRegistry!));
    }
  }

  protected handleArchivedEvent(archivedEvent: ArchivedEvent): void {
    this.eventEmitter.emit("archive", archiveEvent_(archivedEvent))
  }
}

/**
 * Meant to be a simple replacement for Ledger from @daml/ledger
 */
export class Ledger {
  private client: TypedHttpClient;
  private ledgerEndCache?: { offset: number; timestamp: number };
  private ledgerEndPromise?: Promise<number>;
  private tokenUserId: string;
  private tokenUserInfo: User | null = null;
  private httpBaseUrl: string;
  private options: LedgerOptions;

  constructor(options: LedgerOptions) {
    this.httpBaseUrl = options.httpBaseUrl;

    // Log token expiration info during ledger initialization
    const tokenInfo = logTokenExpiration(options.token, `Ledger initialization`);
    this.tokenUserId = tokenInfo.userId;

    this.client = new TypedHttpClient({
      token: options.token,
      baseUrl: this.httpBaseUrl,
      validation: options.validation,
      openApiSchemaPath: options.openApiSchemaPath,
    });
    this.options = options;
  }

  private generateCommandId(): LedgerString {
    return createLedgerString(`cmd-${Date.now()}-${Math.random().toString(36).substring(2, 13)}`);
  }

  private async resolveOffset(offset: LedgerOffset): Promise<number> {
    logger.log(`Resolving offset: ${offset}`);

    if (typeof offset === "number") {
      return offset;
    }

    if (offset === "start") {
      return 0; // Ledger begin
    }

    if (offset === "end") {
      const result = await this.getLedgerEnd();
      return result;
    }

    throw new Error(`Invalid offset: ${offset}`);
  }

  private async getLedgerEnd(): Promise<number> {
    // If there's already a request in flight, return that promise
    if (this.ledgerEndPromise) {
      return this.ledgerEndPromise;
    }

    // Check cache (valid for 1 second to avoid excessive API calls)
    const now = Date.now();
    if (this.ledgerEndCache && now - this.ledgerEndCache.timestamp < 1000) {
      return this.ledgerEndCache.offset;
    }

    // Create new promise for ledger end request
    this.ledgerEndPromise = this.client.getLedgerEnd().then(endResponse => endResponse.offset);

    try {
      const offset = await this.ledgerEndPromise;
      // Cache the result
      this.ledgerEndCache = { offset, timestamp: now };
      return offset;
    } finally {
      // Clear the promise so next request can make a new one if needed
      this.ledgerEndPromise = undefined;
    }
  }

  getTokenUserId(): string {
    return this.tokenUserId;
  }

  async getTokenUserInfo(): Promise<User | null> {
    if (this.tokenUserInfo) {
      return this.tokenUserInfo;
    } else {
      this.tokenUserInfo = await this.getUserInfo(this.tokenUserId);
      return this.tokenUserInfo;
    }
  }

  async getTokenActAsParties(): Promise<Party[]> {
    const userInfo = await this.getTokenUserInfo();
    return (
      userInfo?.rights.filter(right => right.type === "canActAs").map(right => right.party) || []
    );
  }

  /**
   * Query for the Active Contract Set of a specific template.
   * @param template a Template instance as generated by the codegen
   * @param atOffset Whether we want to get historical or just the current
   *  state, default.
   * @param includeCreatedEventBlob 
   * @param verbose 
   * @param readAsParties 
   * @returns 
   */
  async query<T extends object, K = unknown>(
    template: Template<T, K, PackageIdString>,
    atOffset: LedgerOffset = "end",
    includeCreatedEventBlob: boolean = false,
    verbose: boolean = false,
    readAsParties?: Party[]
  ): Promise<CreateEvent<T, K>[]> {
    const activeAtOffset = await this.resolveOffset(atOffset);

    const readAsParties_ = readAsParties || (await this.getTokenActAsParties());

    let filtersByParty = readAsParties_.reduce((acc: Record<string, Filters>, key: Party) => {
      acc[key as string] = {
        cumulative: [
          {
            identifierFilter: 
              templateFilter(template.templateId, includeCreatedEventBlob),
          },
        ],
      };
      return acc;
    }, {});

    const queryRequest: Schemas["GetActiveContractsRequest"] = {
      verbose: false, // To be deprecated do not rely
      activeAtOffset,
      eventFormat: {
        filtersByParty,
        verbose,
      },
    };

    const response = await this.client.queryActiveContracts(queryRequest);

    // Convert the response to our CreateEvent format
    return response.reduce(
      (acc: CreateEvent<T, K>[], item: Schemas["JsGetActiveContractsResponse"]) => {
        // Skip non-active contract entries
        if (!("JsActiveContract" in item.contractEntry)) {
          logger.debug(`Skipping non-active contract entry: ${JSON.stringify(item.contractEntry)}`);
          return acc;
        }

        const contractEntry = item.contractEntry as {
          JsActiveContract: Schemas["JsActiveContract"];
        };
        const createEvent = contractEntry.JsActiveContract.createdEvent;

        // Verify we got the correct template
        if (!matchesPartiallyQualified(createEvent.templateId, template.templateId)) {
          logger.warn(
            `Template ID mismatch: expected ${template.templateId}, got ${createEvent.templateId}`
          );
          return acc; // Skip contracts with mismatched template IDs
        }

        acc.push(createEvent_(createEvent, this.options.versionedRegistry));
        return acc;
      },
      []
    );
  }

  /**
   * Query for instances of a given interface.
   * @param interface_ 
   * @param atOffset 
   * @param includeCreatedEventBlob 
   * @param verbose 
   * @param readAsParties 
   * @returns 
   */
  async queryInterface<I extends object, K = unknown>(
    interface_: InterfaceCompanion<I, K, PackageIdString>,
    atOffset: LedgerOffset = "end",
    includeCreatedEventBlob: boolean = false,
    verbose: boolean = false,
    readAsParties?: Party[]
  ): Promise<Interface<I>[]> {
    if (this.options.versionedRegistry === undefined) {
      throw new Error("Versioned registry is required for interface queries.");
    }
    const versionedRegistry = this.options.versionedRegistry;
    const activeAtOffset = await this.resolveOffset(atOffset);

    const readAsParties_ = readAsParties || (await this.getTokenActAsParties());

    let filtersByParty = readAsParties_.reduce((acc: Record<string, Filters>, key: Party) => {
      acc[key as string] = {
        cumulative: [
          {
            identifierFilter: 
              interfaceFilter(interface_.templateId, includeCreatedEventBlob),
          },
        ],
      };
      return acc;
    }, {});

    const queryRequest: Schemas["GetActiveContractsRequest"] = {
      verbose: false, // To be deprecated do not rely
      activeAtOffset,
      eventFormat: {
        filtersByParty,
        verbose,
      },
    };

    const response = await this.client.queryActiveContracts(queryRequest);

    // Convert the response to our CreateEvent format
    return response.reduce(
      (acc: Interface<I>[], item: Schemas["JsGetActiveContractsResponse"]) => {
        // Skip non-active contract entries
        if (!("JsActiveContract" in item.contractEntry)) {
          logger.debug(`Skipping non-active contract entry: ${JSON.stringify(item.contractEntry)}`);
          return acc;
        }

        const contractEntry = item.contractEntry as {
          JsActiveContract: Schemas["JsActiveContract"];
        };
        const createEvent = contractEntry.JsActiveContract.createdEvent;

        for (const interfaceView of createEvent.interfaceViews ?? []){
          if (matchesPartiallyQualified(interfaceView.interfaceId, interface_.templateId)){
            const interfaceEvent = interfaceEvent_<I>(createEvent, interfaceView, versionedRegistry);
            if (interfaceEvent !== null) {
              acc.push(interfaceEvent);
            }
          } else {
            logger.debug(`Ignoring interface ${interfaceView.interfaceId} as it does not match ${interface_.templateId}.`);
          }
        }
        return acc;
      },
      []
    );
  }

  /**
   * Create a template
   * @param template 
   * @param payload 
   * @param actAs 
   * @returns 
   */
  async create<T extends object, K = unknown, TTemplateId extends string = string>(
    template: Template<T, K, TTemplateId>,
    payload: T,
    actAs?: Party[]
  ): Promise<CreateEvent<T, K>> {
    const createCommand: Schemas["CreateCommand"] = {
      templateId: template.templateId,
      createArguments: payload,
    };

    const actAs_ = actAs || (await this.getTokenActAsParties());
    const commands: JsCommands = {
      commands: [{ CreateCommand: createCommand }],
      commandId: this.generateCommandId(),
      actAs: actAs_.map(party => createPartyIdString(party)),
      userId: createUserIdString(this.tokenUserId),
    };

    const request = { commands };
    const response = await this.client.submitAndWaitForTransaction(request);
    const transaction = response.transaction;
    logger.log(`Create Transaction: ${JSON.stringify(transaction)}`);
    const createdEvents = (transaction.events || []).reduce(
      (acc: CreateEvent<T, K>[], event: Schemas["Event"]) => {
        logger.debug(`Checking event: ${JSON.stringify(event)}`);
        if (isCreateEvent(event)) {
          const matchesTemplate = matchesPartiallyQualified(
            event.CreatedEvent.templateId,
            template.templateId
          );
          if (matchesTemplate) {
            logger.debug(`Event matches template, adding to results`);
            acc.push(createEvent_(event.CreatedEvent, this.options.versionedRegistry));
          } else {
            logger.debug(
              `Event templateId: ${event.CreatedEvent.templateId}, ` +
                `does not match requested templateId: ${template.templateId}`
            );
          }
        } else {
          logger.debug(`Ignoring non create event in transaction: ${JSON.stringify(event)}`);
        }
        return acc;
      },
      []
    );

    if (createdEvents.length === 0) {
      throw new Error(`No created event found for template ${template.templateId}`);
    } else if (createdEvents.length > 1) {
      throw new Error(
        `Multiple create ${JSON.stringify(createdEvents)} ` +
          `events found for template ${template.templateId}`
      );
    }

    // We've already checked that createdEvents.length > 0, so this is safe
    // Use non-null assertion to tell TypeScript this can't be undefined
    return createdEvents[0]!;
  }

  /**
   * Exercise a choice of a given contract
   * @param choice 
   * @param contractId 
   * @param argument 
   * @param actAs 
   * @returns 
   */
  async exercise<T extends object, C, R, K = unknown>(
    choice: Choice<T, C, R, K>,
    contractId: ContractId<T>,
    argument: C,
    actAs?: Party[]
  ): Promise<Event<object, unknown>[]> {
    // Extract actAs from meta or use a default
    const exerciseCommand = {
      templateId: choice.template().templateId,
      contractId: createLedgerString(contractId.toString()),
      choice: createNameString(choice.choiceName),
      choiceArgument: argument,
    };

    const actAs_ = actAs || (await this.getTokenActAsParties());
    const commands: JsCommands = {
      commands: [{ ExerciseCommand: exerciseCommand }],
      commandId: this.generateCommandId(),
      actAs: actAs_.map(party => createPartyIdString(party)),
      // Ends up being not optional
      userId: createUserIdString(this.tokenUserId),
    };

    const request = { commands };
    const response = await this.client.submitAndWaitForTransaction(request);
    const transaction = response.transaction;
    const events: Event<object>[] = [];

    // TODO: Convert this to the other transaction format to capture the
    // exercise result and the resulting events.
    for (const event of transaction.events || []) {
      logger.log(`Processing exercise resulting event: ${JSON.stringify(event)}`);
      if ("CreatedEvent" in event) {
        // Convert to our Event format
        events.push(createEvent_(event.CreatedEvent, this.options.versionedRegistry));
      } else if ("ArchivedEvent" in event) {
        // Convert to our Event format
        events.push(archiveEvent_(event.ArchivedEvent));
      } else {
        // Since we are using ACS_DELTA we can ignore ExercisedEvent
        throw new Error(`Unexpected event type: ${JSON.stringify(event)}`);
      }
    }

    return events;
  }

  /**
   * `submit` allows combining multiple commands into a single Canton
   * transaction. Similar to `create` and `exercise` one can use `createCmd`
   * and `exerciseCmd` to create commands, that are then passed to `submit`.
   * 
   * @param commands 
   * @param actAs Defaults to the actAs parties of the user in the token.
   * @returns Stream of events resulting from the submitted commands.
   */
  async submit(
    commands: Command<any, any>[],
    actAs?: Party[]
  ): Promise<Event<object, unknown>[]> {
    const jsCommands = commands.map((command) => convertCommand(command));

    // Extract actAs from meta or use a default
    const actAs_ = actAs || (await this.getTokenActAsParties());
    const requestCommands: JsCommands = {
      commands: jsCommands,
      commandId: this.generateCommandId(),
      actAs: actAs_.map(party => createPartyIdString(party)),
      // Ends up being not optional
      userId: createUserIdString(this.tokenUserId),
    };

    const request = { commands: requestCommands };
    const response = await this.client.submitAndWaitForTransaction(request);
    const transaction = response.transaction;
    const events: Event<object>[] = [];

    for (const event of transaction.events || []) {
      logger.log(`Processing exercise resulting event: ${JSON.stringify(event)}`);
      if ("CreatedEvent" in event) {
        // Convert to our Event format
        events.push(createEvent_(event.CreatedEvent, this.options.versionedRegistry));
      } else if ("ArchivedEvent" in event) {
        // Convert to our Event format
        events.push(archiveEvent_(event.ArchivedEvent));
      } else {
        // Since we are using ACS_DELTA we can ignore ExercisedEvent
        throw new Error(`Unexpected event type: ${JSON.stringify(event)}`);
      }
    }

    return events;
  }

  private initClient(): WebSocketClient {
    const wsBaseUrl =
      this.options.wsBaseUrl ||
      this.httpBaseUrl.replace(/^https?:/, this.httpBaseUrl.startsWith("https:") ? "wss:" : "ws:");
    return new WebSocketClient({
      token: this.options.token,
      wsBaseUrl: wsBaseUrl,
      validation: this.options.validation,
      asyncApiSchemaPath: this.options.asyncApiSchemaPath,
    });
  }

  /**
   * Stream functionality using WebSockets
   *
   * @param template The template to stream
   * @param readAsParties Array of parties to stream for, if not specified default to
   *          the actAs parties of the user in the token.
   * @param offset Optional offset to start streaming from
   * @param skipAcs Whether to skip archived contracts
   * @param includeCreatedEventBlob Whether to include created event blobs
   * @param readAsParties Array of parties to stream for, if not specified default to
   *          the actAs parties of the user in the token.
   * @returns A stream of events for the specified template or interface
   */
  async streamQuery<T extends object, K = unknown>(
    template: Template<T, K>,
    offset: LedgerOffset = "end",
    skipAcs: boolean = false,
    includeCreatedEventBlob: boolean = false,
    readAsParties?: Party[]
  ): Promise<Stream<T, K>> {
    const activeAtOffset = await this.resolveOffset(offset);
    const parties_ = readAsParties || (await this.getTokenActAsParties());
    return new LedgerStream<T, K>(
      [ { type: "template", templateId: template.templateId as PackageIdString }],
      parties_,
      this.initClient(),
      activeAtOffset,
      skipAcs,
      includeCreatedEventBlob,
      this.options.versionedRegistry,
      this.options.autoReconnect ?? true,
    );
  }

  async streamQueryInterface<I extends object, K = unknown>(
    interface_: InterfaceCompanion<I, K>,
    offset: LedgerOffset = "end",
    skipAcs: boolean = false,
    includeCreatedEventBlob: boolean = false,
    readAsParties?: Party[]
  ): Promise<InterfaceStream<I>> {
    const activeAtOffset = await this.resolveOffset(offset);
    const parties_ = readAsParties || (await this.getTokenActAsParties());
    if (!this.options.versionedRegistry) {
      throw new Error("VersionedRegistry expected for streamQueryInterface provided");
    }
    return new InterfaceStreamImpl<I>(
      [ { type: "interface", interfaceId: interface_.templateId as PackageIdString }],
      parties_,
      this.initClient(),
      activeAtOffset,
      this.options.versionedRegistry,
      skipAcs,
      includeCreatedEventBlob,
      this.options.autoReconnect ?? true,
    );
  }

  /**
   * Create a type-safe MultiStream for working with multiple templates
   *
   * @example
   * ```typescript
   * // Define your template mapping
   * type MyTemplates = {
   *   [UserTemplate.templateId]: { contractType: UserContract, keyType: UserKey },
   *   [AccountTemplate.templateId]: { contractType: AccountContract, keyType: AccountKey }
   * };
   *
   * // Create a type-safe multi-stream
   * const stream = await ledger.createMultiStream<MyTemplates>(
   *   [UserTemplate, AccountTemplate],
   *   [party]
   * );
   *
   * // Use template-specific handlers with proper typing
   * stream.onCreate(UserTemplate.templateId, (event) => {
   *   // event.payload is typed as UserContract
   *   logger.log("User created:", event.payload.username);
   * });
   *
   * stream.onCreate(AccountTemplate.templateId, (event) => {
   *   // event.payload is typed as AccountContract
   *   logger.log("Account created:", event.payload.accountNumber);
   * });
   *
   * stream.start();
   * ```
   *
   * @param tm Template mapping for the streams
   * @param offset Optional offset to start streaming from
   * @param skipAcs Whether to skip loading the initial active contract set
   * @param includeCreatedEventBlob Whether to include created event blobs
   * @param readAsParties Array of parties to stream for, if not specified default to
   *          the actAs parties of the user in the token.
   * @returns A type-safe MultiStream for working with multiple templates
   */
  async createMultiStream<TM extends TemplateMapping>(
    tm: TM,
    offset: LedgerOffset = "end",
    skipAcs: boolean = false,
    includeCreatedEventBlob: boolean = false,
    readAsParties?: Party[]
  ): Promise<MultiStream<TM>> {
    const activeAtOffset = await this.resolveOffset(offset);

    const filters : FilterSpec[] = Object.keys(tm).map((id) => {
      return {type: 'template', templateId: id as PackageIdString };
    });
    const parties_ = readAsParties || (await this.getTokenActAsParties());
    const stream = new LedgerStream<object, unknown>(
      filters,
      parties_,
      this.initClient(),
      activeAtOffset,
      skipAcs,
      includeCreatedEventBlob,
      this.options.versionedRegistry,
      this.options.autoReconnect ?? true,
    );

    return new MultiStreamAdapter<TM>(stream);
  }

  async createMultiInterfaceStream<IM extends InterfaceMapping>(
    im: IM,
    offset: LedgerOffset = "end",
    skipAcs: boolean = false,
    includeCreatedEventBlob: boolean = false,
    readAsParties?: Party[]
  ): Promise<InterfaceMultiStream<IM>> {
    const activeAtOffset = await this.resolveOffset(offset);

    const filters : FilterSpec[] = Object.keys(im).map((id) => {
      return {type: 'interface', interfaceId: id as PackageIdString };
    });
    const parties_ = readAsParties || (await this.getTokenActAsParties());
    
    if (!this.options.versionedRegistry) {
      throw new Error("VersionedRegistry expected for createMultiInterfaceStream");
    }
    
    const stream = new InterfaceStreamImpl<object>(
      filters,
      parties_,
      this.initClient(),
      activeAtOffset,
      this.options.versionedRegistry,
      skipAcs,
      includeCreatedEventBlob,
      this.options.autoReconnect ?? true,
    );

    return new InterfaceMultiStreamImpl<IM>(stream);
  }
  // User information
  async getUserInfo(userId: string): Promise<User | null> {
    const response = await this.client.getUserInfo(userId);
    if (!response.user) {
      logger.warn(`User '${userId}' not found in v2/users/${userId}.`);
      return null;
    } else {
      let userRights = await this.client.getUserRights(userId);
      return {
        userId: createUserIdString(response.user.id),
        primaryParty: response.user.primaryParty,
        rights: userRights.rights?.map(translate.userRights) || [],
      };
    }
  }

  // Party management
  async getParties(): Promise<PartyDetails[]> {
    const response = await this.client.getParties();
    return (response.partyDetails || []).map((party: Schemas["PartyDetails"]) => ({
      party: party.party as Party, // Keep as Party type for compatibility
      displayName: party.localMetadata?.annotations?.displayName,
      isLocal: party.isLocal || false,
    }));
  }

  async allocateParty(request: AllocatePartyRequest): Promise<AllocatePartyResponse> {
    const allocateRequest: Schemas["AllocatePartyRequest"] = {
      partyIdHint: request.partyIdHint
        ? createPartyIdString(request.partyIdHint)
        : createPartyIdString(""),
      identityProviderId: "default", // Use default identity provider
      synchronizerId: "", 
      userId: "", // Do not assign to user.
      ...(request.displayName && {
        localMetadata: {
          resourceVersion: "",
          annotations: { displayName: request.displayName },
        },
      }),
    };

    const response = await this.client.allocateParty(allocateRequest);

    return {
      partyDetails: {
        party: (response.partyDetails?.party || "") as Party,
        displayName: response.partyDetails?.localMetadata?.annotations?.displayName,
        isLocal: response.partyDetails?.isLocal || false,
      },
    };
  }
}
