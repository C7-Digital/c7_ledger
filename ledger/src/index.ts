// Main export for the new ledger package
export { Ledger, type LedgerOptions, createCmd, createAndExerciseCmd, exerciseCmd, convertCommand } from "./ledger";
export { TypedHttpClient, type TypedHttpClientConfig, LedgerApiError } from "./client";
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
export { type ValidationMode } from "./validation";
export { type Logger, ConsoleLogger, NoOpLogger, logger, setLogger } from "./logger";
export * from "./types";
export * from "./valueTypes";

export { SDK_VERSION } from "./generated/sdk-version";
