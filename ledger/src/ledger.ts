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
import { decodeExerciseResult } from "./exerciseResult";
import { components } from "./generated/api";
import { TypedHttpClient } from "./client";
import {
  WebSocketClient,
  StreamConfig,
  ActiveContractsStreamRequest,
  ActiveContractsResponse,
  UpdatesResponse,
  UpdatesStreamRequest,
  isTransaction,
} from "./websocket";
import { MultiStreamAdapter, InterfaceMultiStreamImpl } from "./multistream";
import {
  AllocatePartyRequest,
  AllocatePartyResponse,
  AnyCommand,
  ArchiveEvent,
  CantonError,
  CreateCommand,
  CreateAndExerciseCommand,
  CreateEvent,
  DisclosedContract,
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
  SortedEvents,
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
  IdentifierString,
  NameString,
} from "./valueTypes";

type Filters = components["schemas"]["Filters"];
type JsCommands = Schemas["JsCommands"];
type JsCommand = Schemas["Command"];
type Schemas = components["schemas"];
type CreatedEvent = Schemas["CreatedEvent"];
type ArchivedEvent = Schemas["ArchivedEvent"];
type JsInterfaceView = Schemas["JsInterfaceView"];

/**
 * One entry of the array returned by `POST /v2/state/active-contracts`.
 * Aliases the OpenAPI-generated `JsGetActiveContractsResponse` schema as
 * a public, stable name so callers consuming raw ACS rows from a
 * non-`Ledger` transport (e.g. dapp-sdk's `canton_ledgerApi` proxy)
 * don't have to reach into the codegen namespace.
 */
export type ActiveContractsRow = Schemas["JsGetActiveContractsResponse"];

// Type guard to check if an event is a CreatedEvent
function isCreateEvent(
  event: Schemas["Event"]
): event is { CreatedEvent: Schemas["CreatedEvent"] } {
  return "CreatedEvent" in event;
}

function createEventWithoutDecoder(
  cantonEvent: CreatedEvent,
  synchronizerId?: string,
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
    synchronizerId,
    nodeId: cantonEvent.nodeId,
  };
}

// This term is so overloaded, lets add a '_' to help differentiate
function createEvent_<T extends object, K = unknown>(
  cantonEvent: CreatedEvent,
  versionedRegistry?: VersionedRegistry,
  synchronizerId?: string,
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
    console.debug(`Using default lookupTemplate for ${cantonEvent.templateId}`);
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
    synchronizerId,
    createdEventBlob: cantonEvent.createdEventBlob || "",
    packageVersion,
    nodeId: cantonEvent.nodeId,
  };
}

/**
 * Convert an array of {@link ActiveContractsRow}s (the response body of
 * `POST /v2/state/active-contracts`) into typed, value.proto-branded
 * {@link CreateEvent}s.
 *
 * Filters and logs in one pass:
 *   - Non-active-contract entries (`JsEmpty` / `JsIncompleteAssigned` /
 *     `JsIncompleteUnassigned`) are dropped with a `debug`-level log.
 *   - If `expectedTemplateId` is provided, rows whose
 *     `createdEvent.templateId` doesn't match it under
 *     {@link matchesPartiallyQualified} are dropped with a `warn`-level
 *     log — mirrors {@link Ledger.query}'s diagnostic so the same triage
 *     signal is preserved when callers go off-Ledger.
 *
 * Use this when consuming ACS responses obtained from a transport that
 * gave you raw rows but bypassed {@link Ledger.query} — e.g. dapp-sdk's
 * CIP-0103 `canton_ledgerApi` proxy in wallet/proxied mode. You get the
 * same decoded `CreateEvent<T>` shape (decoder-applied payload,
 * synchronizerId carried through) without reimplementing the inner
 * conversion.
 */
export function createEventsFromWire<T extends object, K = unknown>(
  rows: ActiveContractsRow[],
  versionedRegistry?: VersionedRegistry,
  expectedTemplateId?: string,
): CreateEvent<T, K>[] {
  const out: CreateEvent<T, K>[] = [];
  for (const row of rows) {
    if (!row.contractEntry || !("JsActiveContract" in row.contractEntry)) {
      logger.debug(`Skipping non-active contract entry: ${JSON.stringify(row.contractEntry)}`);
      continue;
    }
    const active = row.contractEntry.JsActiveContract;
    const created = active.createdEvent;
    if (
      expectedTemplateId !== undefined &&
      !matchesPartiallyQualified(
        created.templateId as IdentifierString,
        expectedTemplateId
      )
    ) {
      logger.warn(
        `Template ID mismatch: expected ${expectedTemplateId}, got ${created.templateId}`
      );
      continue;
    }
    out.push(createEvent_<T, K>(created, versionedRegistry, active.synchronizerId));
  }
  return out;
}

function archiveEvent_<T extends object>(cantonEvent: ArchivedEvent): ArchiveEvent<T> {
  return {
    type: "archive",
    templateId: cantonEvent.templateId,
    contractId: cantonEvent.contractId as unknown as ContractId<T>,
    witnessParties: (cantonEvent.witnessParties || []) as Party[],
    offset: cantonEvent.offset,
    nodeId: cantonEvent.nodeId,
  };
}

/**
 * Discriminated event emitted by {@link Ledger.streamHistoryUpdates}.
 * Each event carries the participant `offset` it landed at and the
 * sequencer `recordTime` (ISO-8601 UTC) — sufficient for offset-based
 * checkpointing and for time-windowed aggregates on the consumer side.
 */
export type HistoryEvent<T extends object, K = unknown> =
  | {
      kind: "create";
      offset: number;
      recordTime: string;
      event: CreateEvent<T, K>;
    }
  | {
      kind: "archive";
      offset: number;
      recordTime: string;
      event: ArchiveEvent<T>;
    };

/**
 * Build an AsyncIterable that pulls events off a `wsClient.streamUpdates`
 * subscription. Decouples the WebSocket's push-based callback API from
 * the consumer's pull-based `for await` loop via an internal queue +
 * pending-resolver list.
 *
 *   - On `next()` with events buffered → resolves immediately with the
 *     next event.
 *   - On `next()` with the queue empty → parks the resolver until the
 *     WS pushes a new event (or closes).
 *   - On WS close → all parked resolvers resolve `{done: true}` and any
 *     subsequent `next()` returns the same.
 *   - On WS error → the next pending or future `next()` rejects with
 *     the error; the iterable is considered done.
 *   - On consumer `return()` (e.g. breaking out of a `for await` loop) →
 *     closes the WS and marks the iterable done.
 *
 * The WS request can be bounded (`endInclusive` set → server closes at
 * that offset) or open-ended. For the open-ended case the consumer is
 * responsible for ending iteration explicitly.
 */
// Backstop on the consumer-slower-than-producer case: when the internal
// queue grows past this many events without a corresponding next()
// drain, the iterator fails with a clear overflow error and the WS is
// closed. Sized so 10–100 seconds of typical Canton transaction throughput
// will fit comfortably, but a runaway producer + dormant consumer can't
// drive the process to OOM in a long-running stream.
const HISTORY_ITERABLE_MAX_QUEUE = 10_000;

function makeHistoryIterable<T extends object, K = unknown>(
  wsClient: WebSocketClient,
  request: UpdatesStreamRequest,
  versionedRegistry?: VersionedRegistry,
): AsyncIterable<HistoryEvent<T, K>> {
  return {
    [Symbol.asyncIterator]() {
      const queue: HistoryEvent<T, K>[] = [];
      const resolvers: Array<{
        resolve: (v: IteratorResult<HistoryEvent<T, K>>) => void;
        reject: (e: unknown) => void;
      }> = [];
      let done = false;
      // Sticky — once set, every next() call rejects with this error. We
      // never clear it: contract is "the stream has failed permanently",
      // not "next() may resume normal operation after the first rejection".
      let pendingError: Error | null = null;
      let stop: (() => void) | undefined;

      const push = (event: HistoryEvent<T, K>): void => {
        if (done) return;
        // FIFO match — each parked next() is a separate request for ONE
        // event. Resolving all of them with this event would either
        // duplicate it across callers or starve subsequent events.
        const r = resolvers.shift();
        if (r) {
          r.resolve({ value: event, done: false });
          return;
        }
        if (queue.length >= HISTORY_ITERABLE_MAX_QUEUE) {
          // Consumer is too slow; back off by failing the stream with a
          // diagnostic instead of letting the queue grow without bound.
          fail(
            new Error(
              `streamHistoryUpdates: consumer too slow — internal queue exceeded ` +
                `${HISTORY_ITERABLE_MAX_QUEUE} buffered events. Closing the WebSocket.`,
            ),
          );
          return;
        }
        queue.push(event);
      };

      const finish = (): void => {
        if (done) return;
        done = true;
        const pending = resolvers.splice(0);
        for (const r of pending) {
          r.resolve({ value: undefined, done: true });
        }
      };

      const fail = (e: Error): void => {
        if (done) return; // idempotent — a WS error followed by an
                          // onClose shouldn't re-fail or re-close.
        pendingError = e;
        done = true;
        const pending = resolvers.splice(0);
        for (const r of pending) r.reject(e);
        // Close the WS — `wsClient.streamUpdates`'s onError callback does
        // NOT auto-close (see websocket.ts:173), so leaving this out
        // would leak a live connection plus any in-flight messages it
        // continues to receive.
        try {
          stop?.();
        } catch {
          // best-effort close; the WS might already be in CLOSING
          // state, or `stop` may not have been assigned yet if fail() is
          // invoked synchronously from inside streamUpdates's setup.
        }
      };

      stop = wsClient.streamUpdates(
        request,
        (response: UpdatesResponse) => {
          if (response.status === "error") {
            fail(
              new Error(
                `Canton error in history stream: ${JSON.stringify(response.error)}`,
              ),
            );
            return;
          }
          const update = response.data.update;
          if (!isTransaction(update)) return;
          const jsTransaction = update.Transaction.value;
          const recordTime = jsTransaction.recordTime;
          if (!recordTime) {
            // recordTime is required by Canton's transaction protocol;
            // a missing value is a defect, not a normal case. Drop the
            // whole transaction rather than ship NaN-poisoned events
            // downstream — every event in this transaction would carry
            // the same bad timestamp anyway.
            logger.warn(
              `streamHistoryUpdates: dropping transaction with no recordTime (updateId=${
                jsTransaction.updateId ?? "?"
              })`,
            );
            return;
          }
          for (const event of jsTransaction.events || []) {
            if ("CreatedEvent" in event) {
              try {
                push({
                  kind: "create",
                  offset: event.CreatedEvent.offset,
                  recordTime,
                  event: createEvent_<T, K>(
                    event.CreatedEvent,
                    versionedRegistry,
                    jsTransaction.synchronizerId,
                  ),
                });
              } catch (e) {
                // Skip undecodable creates (template not in registry, etc.)
                // rather than failing the whole stream — bootstrap replays
                // can span heterogeneous template sets.
                logger.warn(
                  `streamHistoryUpdates: skipping CreatedEvent that failed to decode: ${
                    e instanceof Error ? e.message : String(e)
                  }`,
                );
              }
            } else if ("ArchivedEvent" in event) {
              push({
                kind: "archive",
                offset: event.ArchivedEvent.offset,
                recordTime,
                event: archiveEvent_<T>(event.ArchivedEvent),
              });
            }
          }
        },
        (err) => fail(err),
        (_code, _reason) => finish(),
      );

      return {
        next(): Promise<IteratorResult<HistoryEvent<T, K>>> {
          // Sticky error — every call after a fail() rejects with the same
          // error. This matches the doc comment's contract ("future
          // next() rejects with the error") and prevents callers from
          // silently observing `{done: true}` after a failure, which
          // would mask the underlying problem.
          if (pendingError) return Promise.reject(pendingError);
          if (queue.length > 0) {
            return Promise.resolve({ value: queue.shift()!, done: false });
          }
          if (done) {
            return Promise.resolve({
              value: undefined as unknown as HistoryEvent<T, K>,
              done: true,
            });
          }
          return new Promise((resolve, reject) => {
            resolvers.push({ resolve, reject });
          });
        },
        async return(): Promise<IteratorResult<HistoryEvent<T, K>>> {
          stop?.();
          finish();
          return { value: undefined as unknown as HistoryEvent<T, K>, done: true };
        },
      };
    },
  };
}

/**
 * Return the events sorted by `nodeId` ascending — the canonical
 * preorder-traversal position of each event within the originating
 * transaction tree — branded as {@link SortedEvents}.
 *
 * The brand is the type system's record of the sort having happened;
 * `Ledger.exercise` and `Ledger.submitWithDisclosures` apply this
 * before returning, so consumers (and helpers like `lookupCreatedEvent`,
 * whose input type is `SortedEvents`) get the guarantee at compile
 * time. We normalise here because the Ledger API proto declares only
 * `repeated Event events = 5` — no explicit ordering guarantee — even
 * though canton's indexer currently emits events ordered by their
 * internal `event_sequential_id` (which corresponds to `nodeId`).
 *
 * Exported so callers that assemble events from other sources (e.g. a
 * relay over their own backend) can produce the branded shape that the
 * lookup helpers require.
 */
export function sortEventsByNodeId<T extends object, K = unknown>(
  events: ReadonlyArray<Event<T, K>>,
): SortedEvents<T, K> {
  // The brand is phantom-only — no runtime field. The double-cast is the
  // unchecked boundary that records the sort having happened.
  return [...events].sort(
    (a, b) => a.nodeId - b.nodeId,
  ) as unknown as SortedEvents<T, K>;
}

// It is possible that we query for a given interface that we are interested in,
// but the underlying contract has multiple interface implementations that we are NOT
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
    interfaceId: interfaceView.interfaceId,
    packageVersion,
  }
}

type IdentifierFilter = components["schemas"]["IdentifierFilter"];
function templateFilter(
  templateId: IdentifierString,
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
  interfaceId: IdentifierString,
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

export function convertCommand(command: AnyCommand) : JsCommand {
  switch (command.type) {
    case 'create':
      return {
        CreateCommand: {
          templateId: command.template.templateId,
          createArguments: command.template.encode(command.payload),
        }
      };
    case 'createAndExercise':
      return {
        CreateAndExerciseCommand: {
          templateId: command.template.templateId,
          createArguments: command.template.encode(command.payload),
          choice: createNameString(command.choice.choiceName),
          choiceArgument: command.choice.argumentEncode(command.argument),
        }
      };
    case 'exercise':
      return {
        ExerciseCommand: {
          templateId: command.choice.template().templateId,
          contractId: createLedgerString(command.contractId),
          choice: createNameString(command.choice.choiceName),
          choiceArgument: command.choice.argumentEncode(command.argument),
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
  /**
   * Artificial delay in milliseconds added before returning HTTP responses.
   * Useful for simulating slow ledger interactions during local development.
   * Defaults to 0 (no delay).
   */
  responseDelay?: number;
  /**
   * Factory for the WebSocket client that backs every stream. Defaults to
   * `new WebSocketClient(config)`. Exposed as a test seam so a fake transport
   * can drive the stream state machine (e.g. the missing-package drop-and-retry
   * path); production code never sets it.
   */
  webSocketClientFactory?: (config: StreamConfig) => WebSocketClient;
  /**
   * Re-widen backoff bounds (ms) for the missing-package retry: while a package
   * is dropped, the stream retries the full filter set on a doubling backoff
   * from min to max. Defaults to 30s..15m ({@link REWIDEN_MIN_MS}/`_MAX_MS`).
   */
  rewidenBackoffMinMs?: number;
  rewidenBackoffMaxMs?: number;
}

type FilterSpec 
  = { type: "template", templateId: IdentifierString } 
  | { type: "interface", interfaceId: IdentifierString };

// Re-widen backoff bounds. While a package is dropped, the stream retries the
// full filter set on this schedule (min, doubling, capped at max) until the
// participant knows the package — so a DAR uploaded after the stream started is
// picked up without a restart.
const REWIDEN_MIN_MS = 30_000;
const REWIDEN_MAX_MS = 900_000; // 15 min

/**
 * Extract the package names from a `PACKAGE_NAMES_NOT_FOUND` cause.
 *
 * The participant builds the cause as (Canton `RequestValidationErrors`,
 * `PackageNamesNotFound.Reject`):
 *
 *   s"The following package names do not match upgradable packages uploaded on
 *     this participant: [${unknownPackageNames.mkString(", ")}]."
 *
 * i.e. a `Set[PackageName]` joined with `", "`, wrapped in `[...]`. The names
 * live only in this prose — the error's structured `resources`/`context` do not
 * carry them — so a string parse is the only option. Package names are LF
 * identifiers (`[a-zA-Z0-9._-]`), so they never contain `,` or `]`.
 *
 * Checked against Canton v3.5.14 (this repo's `canton` submodule, 2026-08); the
 * `PACKAGE_NAMES_NOT_FOUND` error id has existed since Canton 2.9.1. The stable
 * contract the caller relies on is the error CODE, not this prose: if a future
 * Canton changes the wording, this returns `[]`, the caller drops nothing and
 * surfaces the error as before — degrading to fail-loud, never to a wrong drop.
 *
 * TODO: if Canton ever carries the unknown package names in the error's
 * structured fields (`resources`/`context`) rather than only the cause prose,
 * read them from there and delete this regex. Tracked in the repo README.
 *
 * Returns `[]` when the cause has no bracketed list.
 */
export function parseMissingPackageNames(cause: string | undefined): string[] {
  if (!cause) return [];
  const match = cause.match(/\[([^\]]+)\]/);
  const list = match?.[1];
  if (!list) return [];
  return list
    .split(",")
    .map(name => name.trim())
    .filter(name => name.length > 0);
}

/**
 * True when a filter's package matches one of the given package names. A
 * template/interface id is `#<package-name>:Module:Entity` (name form) or
 * `<package-id-hash>:Module:Entity` (id form). Only the name form can be
 * matched against the names the participant reports, so an id-form filter never
 * matches — the caller then surfaces the error rather than dropping blindly.
 */
export function filterMatchesPackageName(filter: FilterSpec, names: readonly string[]): boolean {
  const id = filter.type === "template" ? filter.templateId : filter.interfaceId;
  const pkg = id.split(":")[0];
  if (!pkg || !pkg.startsWith("#")) return false;
  return names.includes(pkg.slice(1));
}

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
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  // The complete filter set the caller asked for. `activeFilters` is the subset
  // currently sent to the participant: a package the participant does not yet
  // know (a DAR not uploaded/vetted) is dropped from it so the rest of the
  // stream survives, and restored from `originalFilters` when re-widening.
  private readonly originalFilters: FilterSpec[];
  private activeFilters: FilterSpec[];
  private readonly includeCreatedEventBlob: boolean;
  // Package names dropped because the participant rejected them. Non-empty means
  // a re-widen is scheduled to try adding them back once their DAR appears.
  private droppedPackageNames = new Set<string>();
  private rewidenTimer?: ReturnType<typeof setTimeout>;
  private readonly rewidenMinMs: number;
  private readonly rewidenMaxMs: number;
  private rewidenBackoffMs: number;

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
    rewidenMinMs: number = REWIDEN_MIN_MS,
    rewidenMaxMs: number = REWIDEN_MAX_MS,
  ) {
    this.parties = parties;
    this.wsClient = wsClient;
    this.offset = startOffset;
    this.skipAcs = skipAcs;
    this.versionedRegistry = versionedRegistry;
    this.autoReconnect = autoReconnect;
    this.includeCreatedEventBlob = includeCreatedEventBlob;
    this.rewidenMinMs = rewidenMinMs;
    this.rewidenMaxMs = rewidenMaxMs;
    this.rewidenBackoffMs = rewidenMinMs;
    this.originalFilters = [...filters];
    this.activeFilters = [...filters];
    this.filtersByParty = this.buildFiltersByParty(this.activeFilters);
  }

  /**
   * Build the per-party `cumulative` filter payload from a filter set. Called
   * once in the constructor and again whenever `activeFilters` changes (a
   * package dropped, or the set re-widened back to `originalFilters`).
   */
  private buildFiltersByParty(filters: FilterSpec[]): Record<string, any> {
    const cumulative = filters.map(filter => ({
      identifierFilter: filter.type === "template"
        ? templateFilter(filter.templateId, this.includeCreatedEventBlob)
        : interfaceFilter(filter.interfaceId, this.includeCreatedEventBlob),
    }));
    return this.parties.reduce(
      (acc, party) => {
        acc[party] = { cumulative };
        return acc;
      },
      {} as Record<string, any>
    );
  }

  /**
   * A participant rejects the whole subscription with `PACKAGE_NAMES_NOT_FOUND`
   * when it does not yet know one of the requested package names (a DAR not
   * uploaded/vetted yet). Rather than fail every template, drop the named
   * package(s) from the active filter set and restart the current phase with the
   * rest, so the ACS still populates for every known template. A re-widen is
   * then scheduled to add the package(s) back once their DAR appears.
   *
   * Returns true when it handled the error (dropped and restarted); false when
   * the error is unrelated, or names nothing that matches a current filter — the
   * caller then emits it as before, so this never loops on an unmatched name.
   */
  private handleMissingPackages(error: CantonError, phase: "acs" | "updates"): boolean {
    if (error.code !== "PACKAGE_NAMES_NOT_FOUND") return false;
    if (this.state_ === "stop") return false;

    const names = parseMissingPackageNames(error.cause);
    if (names.length === 0) return false;

    const before = this.activeFilters.length;
    this.activeFilters = this.activeFilters.filter(
      filter => !filterMatchesPackageName(filter, names)
    );
    if (this.activeFilters.length === before) return false; // nothing matched

    names.forEach(name => this.droppedPackageNames.add(name));
    this.filtersByParty = this.buildFiltersByParty(this.activeFilters);
    logger.warn(
      `Participant is missing package name(s) [${names.join(", ")}]; dropped from ` +
        `the stream and retrying with ${this.activeFilters.length} of ` +
        `${this.originalFilters.length} filters. Dropped so far: ` +
        `[${[...this.droppedPackageNames].join(", ")}]. Will re-widen once uploaded.`
    );

    // Restart the failed phase with the reduced set.
    this.stopClient?.();
    this.stopClient = undefined;
    if (phase === "acs") {
      this.startActiveContractsStream();
    } else {
      this.startUpdatesStream();
    }

    this.scheduleRewiden();
    return true;
  }

  /**
   * While any package is dropped, periodically retry the full filter set with a
   * capped, doubling backoff. A re-widen restarts from the ACS phase (not just
   * updates) so a re-added template's already-active contracts are loaded, not
   * only its future ones; re-seeing a tracked contract is idempotent. When the
   * participant accepts the full set (see {@link handleActiveContractsClose}),
   * the dropped set clears and the timer stops.
   */
  private scheduleRewiden(): void {
    if (this.rewidenTimer) return; // one timer at a time
    if (this.droppedPackageNames.size === 0) return;

    this.rewidenTimer = setTimeout(() => {
      this.rewidenTimer = undefined;
      if (this.state_ === "stop" || this.droppedPackageNames.size === 0) return;

      logger.log(
        `Re-widening stream to retry dropped package(s) ` +
          `[${[...this.droppedPackageNames].join(", ")}] after ${this.rewidenBackoffMs}ms`
      );
      this.rewidenBackoffMs = Math.min(this.rewidenBackoffMs * 2, this.rewidenMaxMs);
      this.restartFromAcs(this.originalFilters);
      // If the package is still missing, handleMissingPackages fires again and
      // re-arms this timer (now at the increased backoff).
      this.scheduleRewiden();
    }, this.rewidenBackoffMs);
  }

  /**
   * Tear down the current client and restart from the ACS phase with `filters`,
   * at the current offset. Used to re-widen after a package reappears.
   */
  private restartFromAcs(filters: FilterSpec[]): void {
    this.activeFilters = [...filters];
    this.filtersByParty = this.buildFiltersByParty(this.activeFilters);
    this.stopClient?.();
    this.stopClient = undefined;
    this.state_ = "init";
    this.eventEmitter.emit("state", "init");
    this.startActiveContractsStream();
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

  protected handleCreatedEvent(createdEvent: CreatedEvent, synchronizerId?: string): void {
    this.eventEmitter.emit("create", createEvent_(createdEvent, this.versionedRegistry, synchronizerId));
  }

  protected handleArchivedEvent(archivedEvent: ArchivedEvent): void {
    this.eventEmitter.emit("archive", archiveEvent_(archivedEvent))
  }

  /**
   * Handle responses from the active contracts stream
   */
  private handleActiveContractsResponse(response: ActiveContractsResponse): void {
    if (response.status === "error") {
      if (this.handleMissingPackages(response.error, "acs")) return;
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
      this.handleCreatedEvent(activeContract.createdEvent, activeContract.synchronizerId)
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
      // The ACS phase completed without a PACKAGE_NAMES_NOT_FOUND rejection. If
      // we reached it on the full set, any previously-dropped package has
      // rejoined — clear the dropped state and stop re-widening.
      if (this.droppedPackageNames.size > 0 && this.activeFilters.length === this.originalFilters.length) {
        logger.log(
          `Re-widen succeeded: package(s) [${[...this.droppedPackageNames].join(", ")}] ` +
            `are now known to the participant.`
        );
        this.droppedPackageNames.clear();
        this.rewidenBackoffMs = this.rewidenMinMs;
        if (this.rewidenTimer) {
          clearTimeout(this.rewidenTimer);
          this.rewidenTimer = undefined;
        }
      }
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
      if (this.handleMissingPackages(response.error, "updates")) return;
      this.eventEmitter.emit("error", response.error);
      return;
    }
    const update = response.data.update;
    if (isTransaction(update)) {
      const jsTransaction = update.Transaction.value;
      for (const event of jsTransaction.events || []) {
        if ("CreatedEvent" in event) {
          this.offset = Math.max(this.offset, event.CreatedEvent.offset);
          this.handleCreatedEvent(event.CreatedEvent, jsTransaction.synchronizerId)
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
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = undefined;
        if (this.state_ === "live") {
          // Double-check we're still active
          logger.log(`Attempting to reconnect stream...`);
          // Log token expiration info before reconnection attempt
          logTokenExpiration(this.wsClient.getToken(), "WebSocket reconnection attempt");
          // A reconnect is a free chance to re-widen: if a package was dropped,
          // rebuild from the full set. Restart from the ACS phase so a re-added
          // template's existing contracts load, not only its future ones.
          if (this.droppedPackageNames.size > 0) {
            this.restartFromAcs(this.originalFilters);
          } else {
            this.startUpdatesStream();
          }
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

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    if (this.rewidenTimer) {
      clearTimeout(this.rewidenTimer);
      this.rewidenTimer = undefined;
    }

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

        // Cancel any pending reconnect timer to avoid duplicate connections
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = undefined;
        }

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

  protected handleCreatedEvent(createdEvent: CreatedEvent, synchronizerId?: string): void {
    this.eventEmitter.emit("create", createEventWithoutDecoder(createdEvent, synchronizerId));
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
      responseDelay: options.responseDelay,
    });
    this.options = options;
  }

  /**
   * Update the authentication token used for HTTP requests.
   * Active streams should be updated separately via stream.updateToken().
   */
  setToken(newToken: string): void {
    logTokenExpiration(newToken, "Ledger setToken");
    this.client.token = newToken;
    this.options = { ...this.options, token: newToken };
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
    this.ledgerEndPromise = this.client.getLedgerEnd().then(endResponse => {
      if (endResponse.offset === undefined) {
        throw new Error("Ledger end response missing offset");
      }
      return endResponse.offset;
    });

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

  /** @throws {LedgerApiError} on non-OK HTTP response from the ledger */
  async getTokenUserInfo(): Promise<User | null> {
    if (this.tokenUserInfo) {
      return this.tokenUserInfo;
    } else {
      this.tokenUserInfo = await this.getUserInfo(this.tokenUserId);
      return this.tokenUserInfo;
    }
  }

  /** @throws {LedgerApiError} on non-OK HTTP response from the ledger */
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
   * @param options.limit Caps the returned row count as a URL query param
   *  the JSON API accepts (`?limit=N`). Use when a bounded prefix is
   *  acceptable — e.g. for an aggregate over a large ACS slice where the
   *  participant's `http-list-max-elements-limit` (default 200) would
   *  otherwise reject the call with `JSON_API_MAXIMUM_LIST_ELEMENTS_NUMBER_REACHED`.
   *  Response is silently truncated to `limit` rows with no continuation
   *  token; callers must surface that to the user.
   * @returns
   * @throws {LedgerApiError} on non-OK HTTP response from the ledger
   */
  async query<T extends object, K = unknown, TTemplateId extends string = string>(
    template: Template<T, K, TTemplateId>,
    atOffset: LedgerOffset = "end",
    includeCreatedEventBlob: boolean = false,
    verbose: boolean = false,
    readAsParties?: Party[],
    options?: { limit?: number }
  ): Promise<CreateEvent<T, K>[]> {
    const activeAtOffset = await this.resolveOffset(atOffset);

    const readAsParties_ = readAsParties || (await this.getTokenActAsParties());

    let filtersByParty = readAsParties_.reduce((acc: Record<string, Filters>, key: Party) => {
      acc[key as string] = {
        cumulative: [
          {
            identifierFilter:
              // `query` is generic over the template-id (like `create`) so codegen
              // companions pass without a cast; the brand is internalised here.
              templateFilter(template.templateId as unknown as IdentifierString, includeCreatedEventBlob),
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

    const response = await this.client.queryActiveContracts(queryRequest, options);

    // Wire→domain mapping lives in `createEventsFromWire` so consumers
    // of the wallet proxy (dapp-sdk's `canton_ledgerApi`) apply the same
    // decoder path without re-entering this `Ledger` instance.
    return createEventsFromWire<T, K>(
      response,
      this.options.versionedRegistry,
      template.templateId,
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
   * @throws {LedgerApiError} on non-OK HTTP response from the ledger
   */
  async queryInterface<I extends object, K = unknown, TTemplateId extends string = string>(
    interface_: InterfaceCompanion<I, K, TTemplateId>,
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
              interfaceFilter(interface_.templateId as unknown as IdentifierString, includeCreatedEventBlob),
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
        if (!item.contractEntry || !("JsActiveContract" in item.contractEntry)) {
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
   * @throws {LedgerApiError} on non-OK HTTP response from the ledger
   */
  async create<T extends object, K = unknown, TTemplateId extends string = string>(
    template: Template<T, K, TTemplateId>,
    payload: T,
    actAs?: Party[]
  ): Promise<CreateEvent<T, K>> {
    const createCommand: Schemas["CreateCommand"] = {
      templateId: template.templateId,
      createArguments: template.encode(payload),
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
            acc.push(createEvent_(event.CreatedEvent, this.options.versionedRegistry, transaction.synchronizerId));
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
   * Exercise a choice of a given contract.
   *
   * The returned `Event[]` is the full ACS_DELTA event stream for the
   * resulting transaction, **sorted by `nodeId` ascending** — i.e. in
   * the canonical preorder-traversal position each event occupies in
   * the originating transaction tree. Consumers (and helpers such as
   * `lookupCreatedEvent`) can rely on this order without re-sorting.
   *
   * @param choice
   * @param contractId
   * @param argument
   * @param actAs
   * @returns The transaction's events in `nodeId` order.
   * @throws {LedgerApiError} on non-OK HTTP response from the ledger
   */
  async exercise<T extends object, C, R, K = unknown>(
    choice: Choice<T, C, R, K>,
    contractId: ContractId<T>,
    argument: C,
    actAs?: Party[]
  ): Promise<SortedEvents<object, unknown>> {
    // Extract actAs from meta or use a default
    const exerciseCommand = {
      templateId: choice.template().templateId,
      contractId: createLedgerString(contractId.toString()),
      choice: createNameString(choice.choiceName),
      choiceArgument: choice.argumentEncode(argument),
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

    // ACS_DELTA shape: only Created/Archived events are surfaced (the
    // choice's `exerciseResult` is dropped). Callers who need the
    // return value of a read-only / nonconsuming choice — e.g.
    // `QuoteNextPayment : NextPaymentInfo` — should use
    // {@link Ledger.exerciseResult} instead, which opts into
    // LEDGER_EFFECTS for that one submission.
    for (const event of transaction.events || []) {
      logger.log(`Processing exercise resulting event: ${JSON.stringify(event)}`);
      if ("CreatedEvent" in event) {
        // Convert to our Event format
        events.push(createEvent_(event.CreatedEvent, this.options.versionedRegistry, transaction.synchronizerId));
      } else if ("ArchivedEvent" in event) {
        // Convert to our Event format
        events.push(archiveEvent_(event.ArchivedEvent));
      } else {
        // Since we are using ACS_DELTA we can ignore ExercisedEvent
        throw new Error(`Unexpected event type: ${JSON.stringify(event)}`);
      }
    }

    return sortEventsByNodeId(events);
  }

  /**
   * Exercise a choice and return its DECODED Daml return value (the
   * choice's `R`), not the events list.
   *
   * Use this for nonconsuming / read-only quote choices where {@link exercise}
   * surfaces only the empty ACS-delta event stream because the choice
   * creates no contracts. The Daml return value goes to
   * `/dev/null` under the ACS_DELTA shape the standard `exercise`
   * uses.
   *
   * Mechanically this opts into the `LEDGER_EFFECTS` transaction shape
   * for this one submission: the response then includes the top-level
   * `ExercisedEvent` whose `exerciseResult` carries the JSON-encoded
   * return value. We locate the root exercise node by matching
   * `(choice, contractId)` and decode the result via the choice's
   * `resultDecoder`.
   *
   * **Limitations**: only the TOP-LEVEL `ExercisedEvent`'s result is
   * returned. Child exercises (a choice that calls another choice in
   * its body) are intentionally ignored — the caller asked for THIS
   * choice's result. For choices that also create/archive contracts
   * AND need the events list, follow this with a separate
   * {@link exercise} call (the cost is one extra round-trip), or
   * drop down to the exported {@link TypedHttpClient} and call
   * `submitAndWaitForTransaction` directly with the
   * `TRANSACTION_SHAPE_LEDGER_EFFECTS` shape.
   *
   * @param choice
   * @param contractId
   * @param argument
   * @param actAs Defaults to the actAs parties of the user in the token.
   * @returns The decoded choice return value.
   * @throws {LedgerApiError} on non-OK HTTP response from the ledger.
   * @throws if the LEDGER_EFFECTS response contains no matching
   *         `ExercisedEvent` or its `exerciseResult` is missing — both
   *         indicate the server returned an unexpected shape.
   */
  async exerciseResult<T extends object, C, R, K = unknown>(
    choice: Choice<T, C, R, K>,
    contractId: ContractId<T>,
    argument: C,
    actAs?: Party[]
  ): Promise<R> {
    const exerciseCommand = {
      templateId: choice.template().templateId,
      contractId: createLedgerString(contractId.toString()),
      choice: createNameString(choice.choiceName),
      choiceArgument: choice.argumentEncode(argument),
    };

    const actAs_ = actAs || (await this.getTokenActAsParties());
    const commands: JsCommands = {
      commands: [{ ExerciseCommand: exerciseCommand }],
      commandId: this.generateCommandId(),
      actAs: actAs_.map(party => createPartyIdString(party)),
      userId: createUserIdString(this.tokenUserId),
    };

    // Opt in to LEDGER_EFFECTS so the response contains an
    // ExercisedEvent with `exerciseResult`. The default shape
    // (ACS_DELTA) only surfaces Created/Archived events — for a
    // nonconsuming read-only choice that's an empty list.
    //
    // filtersByParty: an empty Filters object per acting party means
    // "wildcard" — see the Filters schema doc on the OpenAPI spec
    // ("If no CumulativeFilter defined, the default of a single
    // WildcardFilter ... is used.") We want the root exercise event,
    // and its witnesses include the choice's controller (which is one
    // of our act-as parties), so the wildcard filter covers it.
    const transactionFormat = {
      transactionShape:
        "TRANSACTION_SHAPE_LEDGER_EFFECTS" as const,
      eventFormat: {
        filtersByParty: Object.fromEntries(
          actAs_.map(p => [p.toString(), {}])
        ),
        verbose: true,
      },
    };
    const request = { commands, transactionFormat };
    const response = await this.client.submitAndWaitForTransaction(request);
    return decodeExerciseResult(
      response.transaction.events || [],
      choice,
      contractId
    );
  }

  /**
   * `submit` allows combining multiple commands into a single Canton
   * transaction. Similar to `create` and `exercise` one can use `createCmd`
   * and `exerciseCmd` to create commands, that are then passed to `submit`.
   *
   * The returned `Event[]` is sorted by `nodeId` ascending — see
   * {@link Ledger.exercise} for the ordering guarantee.
   *
   * @param commands
   * @param actAs Defaults to the actAs parties of the user in the token.
   * @param commandId Optional command ID; a fresh one is generated if omitted.
   * @returns The transaction's events in `nodeId` order.
   * @throws {LedgerApiError} on non-OK HTTP response from the ledger
   */
  async submit(
    commands: AnyCommand[],
    actAs?: Party[],
    commandId?: string,
  ): Promise<SortedEvents<object, unknown>> {
    return this.submitInternal(commands, actAs, commandId, undefined);
  }

  /**
   * Submit a batch of commands together with a set of disclosed contracts.
   *
   * Disclosed contracts are how Splice/Canton-token-standard workflows let
   * a submitter reference contracts they don't otherwise have visibility
   * into (e.g., the DSO's `AmuletRules`, an `OpenMiningRound`, a featured
   * app right). The off-ledger registry — typically the Splice scan node —
   * is what supplies the `createdEventBlob` for each disclosure.
   *
   * Identical event-decoding behaviour to {@link submit}; the only
   * difference is the additional `disclosedContracts` field on the
   * underlying `JsCommands`. As with {@link Ledger.exercise} and
   * {@link Ledger.submit}, the returned `Event[]` is sorted by
   * `nodeId` ascending.
   *
   * @param commands           Commands to submit atomically.
   * @param disclosedContracts Disclosed contracts to attach to the request.
   * @param actAs              Defaults to the actAs parties of the user in the token.
   * @param commandId          Optional command id; a fresh one is generated if omitted.
   * @returns                  The transaction's events in `nodeId` order.
   * @throws {LedgerApiError}  on non-OK HTTP response from the ledger.
   */
  async submitWithDisclosures(
    commands: AnyCommand[],
    disclosedContracts: DisclosedContract[],
    actAs?: Party[],
    commandId?: string,
  ): Promise<SortedEvents<object, unknown>> {
    return this.submitInternal(commands, actAs, commandId, disclosedContracts);
  }

  private async submitInternal(
    commands: AnyCommand[],
    actAs: Party[] | undefined,
    commandId: string | undefined,
    disclosedContracts: DisclosedContract[] | undefined,
  ): Promise<SortedEvents<object, unknown>> {
    const jsCommands = commands.map((command) => convertCommand(command));
    const actAs_ = actAs || (await this.getTokenActAsParties());
    const requestCommands: JsCommands = {
      commands: jsCommands,
      commandId: commandId
        ? createLedgerString(commandId)
        : this.generateCommandId(),
      actAs: actAs_.map(party => createPartyIdString(party)),
      userId: createUserIdString(this.tokenUserId),
      ...(disclosedContracts !== undefined && { disclosedContracts }),
    };

    const request = { commands: requestCommands };
    const response = await this.client.submitAndWaitForTransaction(request);
    const transaction = response.transaction;
    const events: Event<object>[] = [];

    for (const event of transaction.events || []) {
      logger.log(`Processing exercise resulting event: ${JSON.stringify(event)}`);
      if ("CreatedEvent" in event) {
        events.push(createEvent_(event.CreatedEvent, this.options.versionedRegistry, transaction.synchronizerId));
      } else if ("ArchivedEvent" in event) {
        events.push(archiveEvent_(event.ArchivedEvent));
      } else {
        // Since we are using ACS_DELTA we can ignore ExercisedEvent
        throw new Error(`Unexpected event type: ${JSON.stringify(event)}`);
      }
    }

    return sortEventsByNodeId(events);
  }

  /**
   * Prepare a transaction via the interactive-submission API.
   * Returns cost estimation (traffic bytes) and a prepared transaction blob.
   * Useful for estimating traffic cost before committing.
   *
   * @param commands The commands to prepare
   * @param actAs Defaults to the actAs parties of the user in the token.
   * @param synchronizerId Target synchronizer (optional)
   * @param verboseHashing Include hashing details for debugging (default false)
   * @returns PrepareSubmission response with costEstimation and preparedTransaction
   * @throws {LedgerApiError} on non-OK HTTP response from the ledger
   */
  async prepareSubmission(
    commands: AnyCommand[],
    actAs?: Party[],
    synchronizerId?: string,
    verboseHashing?: boolean,
  ) {
    const jsCommands = commands.map((command) => convertCommand(command));
    const actAs_ = actAs || (await this.getTokenActAsParties());

    return this.client.prepareSubmission({
      commands: jsCommands,
      commandId: this.generateCommandId(),
      userId: createUserIdString(this.tokenUserId),
      actAs: actAs_.map((party) => party.toString()),
      synchronizerId: synchronizerId ?? "",
      verboseHashing: verboseHashing ?? false,
    });
  }

  /**
   * List the synchronizers this participant is currently connected to.
   * Useful for auto-discovering the synchronizer ID when wiring up traffic
   * monitoring or other per-synchronizer state.
   *
   * @param party Optional filter — only synchronizers this party is connected on.
   * @param participantId Optional filter by participant ID.
   * @param identityProviderId Optional identity-provider ID filter.
   * @throws {LedgerApiError} on non-OK HTTP response from the ledger
   */
  async getConnectedSynchronizers(
    party?: Party,
    participantId?: string,
    identityProviderId?: string,
  ) {
    return this.client.getConnectedSynchronizers(party, participantId, identityProviderId);
  }

  private initClient(): WebSocketClient {
    const wsBaseUrl =
      this.options.wsBaseUrl ||
      this.httpBaseUrl.replace(/^https?:/, this.httpBaseUrl.startsWith("https:") ? "wss:" : "ws:");
    const config: StreamConfig = {
      token: this.options.token,
      wsBaseUrl: wsBaseUrl,
      validation: this.options.validation,
      asyncApiSchemaPath: this.options.asyncApiSchemaPath,
    };
    return this.options.webSocketClientFactory
      ? this.options.webSocketClientFactory(config)
      : new WebSocketClient(config);
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
      [ { type: "template", templateId: template.templateId as IdentifierString }],
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
      [ { type: "interface", interfaceId: interface_.templateId as IdentifierString }],
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
   * Stream historical update events for a template over a bounded or
   * open-ended offset range.
   *
   * Differs from {@link streamQuery} in two ways:
   *
   * 1. **No ACS replay.** `streamQuery` first replays the active-contracts
   *    snapshot at the requested offset, then transitions to a live update
   *    feed. This method skips the ACS entirely and pulls pure update
   *    events (CREATE + ARCHIVE) from `/v2/updates`, so consumers see the
   *    create events of contracts that have since been archived — the
   *    exact data needed for "what happened over this window" replays.
   *
   * 2. **AsyncIterable, not event-emitter.** Iteration is consumer-driven
   *    via `for await (const evt of iter) { ... }`. The underlying WS is
   *    closed when the loop returns/throws/breaks, so cleanup is automatic.
   *
   * Use cases:
   *  - Bootstrap-time replay of archived contracts to seed an off-ledger
   *    aggregate (e.g. a rolling time-window average over a field of a
   *    template whose instances are short-lived).
   *  - Auditable history queries over a known offset window.
   *  - Backfilling a new analytics index from a saved offset checkpoint.
   *
   * Caveat: offsets are participant-local and not time-keyed. To slice
   * by wall-clock time the consumer must filter on each event's
   * `recordTime`, and the participant's pruning policy bounds how far
   * back the replay can reach.
   *
   * @param template Daml template companion used for both the filter and
   *                 payload decoding of CreatedEvents.
   * @param options.beginExclusive Offset to start AFTER (defaults to
   *                 `"start"` → 0 = ledger genesis).
   * @param options.endInclusive   Offset to stop AT (defaults to undefined
   *                 → open-ended; the iterable runs until the consumer
   *                 returns / breaks).
   * @param options.readAsParties  Party set the request filters for
   *                 (defaults to the token's actAs parties).
   * @param options.includeCreatedEventBlob Whether CreatedEvents carry
   *                 their canonical blob (defaults to false).
   */
  async streamHistoryUpdates<T extends object, K = unknown>(
    template: Template<T, K>,
    options: {
      beginExclusive?: LedgerOffset;
      endInclusive?: LedgerOffset;
      readAsParties?: Party[];
      includeCreatedEventBlob?: boolean;
    } = {},
  ): Promise<AsyncIterable<HistoryEvent<T, K>>> {
    const beginExclusive = await this.resolveOffset(
      options.beginExclusive ?? "start",
    );
    const endInclusive =
      options.endInclusive !== undefined
        ? await this.resolveOffset(options.endInclusive)
        : undefined;
    const parties = options.readAsParties ?? (await this.getTokenActAsParties());
    const includeCreatedEventBlob = options.includeCreatedEventBlob ?? false;

    const filtersByParty = parties.reduce(
      (acc, party) => {
        acc[party] = {
          cumulative: [
            {
              identifierFilter: templateFilter(
                template.templateId as IdentifierString,
                includeCreatedEventBlob,
              ),
            },
          ],
        };
        return acc;
      },
      {} as Record<string, any>,
    );

    const request: UpdatesStreamRequest = {
      beginExclusive,
      verbose: false,
      updateFormat: {
        includeTransactions: {
          eventFormat: { filtersByParty, verbose: true },
          transactionShape: "TRANSACTION_SHAPE_ACS_DELTA" as const,
        },
      },
      ...(endInclusive !== undefined ? { endInclusive } : {}),
    };

    return makeHistoryIterable<T, K>(
      this.initClient(),
      request,
      this.options.versionedRegistry,
    );
  }

  /**
   * Read the first matching event AT OR AFTER `offset`, scanning up to
   * `scanLimit` offsets forward. Returns `null` if no event lands in
   * the window.
   *
   * Cheap primitive for offset-to-time mappings — e.g. when an
   * off-ledger consumer needs to find the participant offset that
   * roughly corresponds to a wall-clock target without replaying from
   * genesis. Open the same template filter the consumer will stream,
   * collect a handful of `(offset, recordTime)` anchors, extrapolate
   * a target offset, then refine.
   *
   * The window is clamped against the participant's current ledger end,
   * so passing `"end"` or a near-end offset returns promptly with `null`
   * (or a single trailing event, if one happens to live in the last
   * slot) rather than parking on a stream waiting for future events.
   *
   * @param template  Daml template companion — same filter / decoder
   *                  as a subsequent {@link streamHistoryUpdates} call.
   * @param offset    Where to start scanning; `"start"`, `"end"`, or a
   *                  number.
   * @param scanLimit Max offsets to look forward (default 1,000,000).
   */
  async probeOffset<T extends object, K = unknown>(
    template: Template<T, K>,
    offset: LedgerOffset,
    scanLimit: number = 1_000_000,
  ): Promise<{ offset: number; recordTime: string } | null> {
    const begin = await this.resolveOffset(offset);
    const ledgerEnd = await this.getLedgerEnd();
    const beginExclusive = Math.max(0, begin - 1);
    const endInclusive = Math.min(begin + scanLimit, ledgerEnd);
    if (endInclusive <= beginExclusive) return null;
    const iterable = await this.streamHistoryUpdates(template, {
      beginExclusive,
      endInclusive,
      includeCreatedEventBlob: false,
    });
    for await (const event of iterable) {
      return { offset: event.offset, recordTime: event.recordTime };
    }
    return null;
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
      return {type: 'template', templateId: id as IdentifierString };
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
      this.options.rewidenBackoffMinMs ?? REWIDEN_MIN_MS,
      this.options.rewidenBackoffMaxMs ?? REWIDEN_MAX_MS,
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
      return {type: 'interface', interfaceId: id as IdentifierString };
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
  /** @throws {LedgerApiError} on non-OK HTTP response from the ledger */
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

  /** @throws {LedgerApiError} on non-OK HTTP response from the ledger */
  async getParties(): Promise<PartyDetails[]> {
    const response = await this.client.getParties();
    return (response.partyDetails || []).map((party: Schemas["PartyDetails"]) => ({
      party: party.party as Party, // Keep as Party type for compatibility
      displayName: party.localMetadata?.annotations?.displayName,
      isLocal: party.isLocal || false,
    }));
  }

  /** @throws {LedgerApiError} on non-OK HTTP response from the ledger */
  async allocateParty(request: AllocatePartyRequest): Promise<AllocatePartyResponse> {
    const allocateRequest: Schemas["AllocatePartyRequest"] = {
      ...(request.partyIdHint && {
        partyIdHint: createPartyIdString(request.partyIdHint),
      }),
      // The default identity provider is the EMPTY string, not the literal
      // "default" — Canton rejects "default" with INVALID_ARGUMENT
      // ("identity_provider_id Id(default) has not been found"). Matches how
      // `createUser` (below) explicitly sets `identityProviderId: ""` to use
      // the default IDP.
      identityProviderId: "",
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

  /**
   * Create a ledger user with `CanActAs` rights for `actAs` and `CanReadAs`
   * rights for `readAs` (the `primaryParty` defaults to the first actAs party).
   * The user-side counterpart to `allocateParty` — lets callers provision a
   * party + a user to authenticate as it without hand-rolling a `/v2/users`
   * request.
   * @throws {LedgerApiError} on non-OK HTTP response from the ledger
   */
  async createUser(
    userId: string,
    actAs: Party[],
    readAs: Party[] = [],
    primaryParty?: Party
  ): Promise<void> {
    // Normalise/validate identifiers via the branded constructors, like the
    // rest of this file. `primaryParty` is optional — omit it when there's none
    // to set (a read-only user with no primary party is valid; sending "" would
    // be invalid). `identityProviderId` is REQUIRED by the JSON Ledger API
    // (omitting it returns 400 "Missing required field at 'identityProviderId'");
    // "" selects the default identity provider.
    const primary = primaryParty ?? actAs[0];
    const user: Schemas["CreateUserRequest"]["user"] = {
      id: createUserIdString(userId),
      isDeactivated: false,
      identityProviderId: "",
    };
    if (primary) {
      user.primaryParty = createPartyIdString(primary);
    }

    const request: Schemas["CreateUserRequest"] = {
      user,
      rights: [
        ...actAs.map((party) => ({
          kind: { CanActAs: { value: { party: createPartyIdString(party) } } },
        })),
        ...readAs.map((party) => ({
          kind: { CanReadAs: { value: { party: createPartyIdString(party) } } },
        })),
      ],
    };
    await this.client.createUser(request);
  }
}
