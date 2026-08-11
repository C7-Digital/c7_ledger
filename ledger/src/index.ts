// Main export for the new ledger package
export {
  Ledger,
  type LedgerOptions,
  type HistoryEvent,
  type ActiveContractsRow,
  createCmd,
  createAndExerciseCmd,
  createEventsFromWire,
  exerciseCmd,
  convertCommand,
} from "./ledger";
export { TypedHttpClient, type TypedHttpClientConfig } from "./client";
export { LedgerApiError, type LedgerErrorBody } from "./error";
export {
  WebSocketClient,
  type StreamConfig,
  type CompletionStreamRequest,
  type CompletionStreamMessage,
  type ActiveContractsStreamRequest,
  type ActiveContractsStreamMessage,
  type UpdatesStreamRequest,
  type UpdatesStreamMessage,
} from "./websocket";
export {
  type CantonErrorCategory,
  type CantonResourceKind,
  categoryOf,
  isRetryable,
  resourcesOf,
  cantonErrorOf,
} from "./cantonError";
export { type ValidationMode } from "./validation";
export { type Logger, ConsoleLogger, NoOpLogger, logger, setLogger } from "./logger";
export * from "./types";
export * from "./events";
export * from "./valueTypes";
export { decodeExerciseResult } from "./exerciseResult";

// Re-export the JSON Ledger API OpenAPI schemas so consumers can name
// wire-response shapes (`apiComponents["schemas"]["Event"]`,
// `["JsGetUpdateResponse"]`, etc.) without redeclaring slivers. Used by
// `@c7-private/dapp-stack`'s `ExternalPartySession` to type the wallet-
// proxied `sdk.ledgerApi(...)` response before handing it to
// {@link decodeExerciseResult}. `apiComponents` mirrors the local alias
// used in `types.ts`.
export type { components as apiComponents } from "./generated/api";

export { SDK_VERSION } from "./generated/sdk-version";
