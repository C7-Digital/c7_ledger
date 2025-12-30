/**
 * WebSocket client for Canton's AsyncAPI v2 streaming endpoints
 *
 * Provides real-time event streaming for completions, active contracts,
 * and ledger updates using WebSocket connections with proper authentication
 * and typed message handling.
 */
import type { channels, components } from "./generated/async-api";
import { SchemaValidator, ValidationMode } from "./validation";
import { logger } from "./logger";
import { logTokenExpiration } from "./token";
import WebSocket from "isomorphic-ws";

export interface StreamConfig {
  token: string;
  wsBaseUrl: string;
  validation?: ValidationMode;
  asyncApiSchemaPath?: string;
}

// Extract channel endpoint keys for compile-time validation
type ChannelEndpoint = keyof channels;

type CompletionChannel = channels["/v2/commands/completions"];
type ActiveContractsChannel = channels["/v2/state/active-contracts"];
type UpdatesChannel = channels["/v2/updates/flats"];

// Re-export AsyncAPI types for convenience
export type CompletionStreamRequest = CompletionChannel["publish"]["message"];
export type CompletionStreamMessage = CompletionChannel["subscribe"]["message"];
export type ActiveContractsStreamRequest = ActiveContractsChannel["publish"]["message"];
export type ActiveContractsStreamMessage = ActiveContractsChannel["subscribe"]["message"];
export type UpdatesStreamRequest = UpdatesChannel["publish"]["message"];
export type UpdatesStreamMessage = UpdatesChannel["subscribe"]["message"];

// Helper type to get request/response types for a given endpoint
type EndpointRequestType<T extends ChannelEndpoint> = channels[T]["publish"]["message"];
type EndpointResponseType<T extends ChannelEndpoint> = channels[T]["subscribe"]["message"];

// Error type from the AsyncAPI schema
export type JsCantonError = components["schemas"]["JsCantonError"];

// Discriminated union types for stream responses
export type Response<T> =
  | { status: "success"; data: T }
  | { status: "error"; error: JsCantonError };

export type CompletionResponse = Response<components["schemas"]["CompletionStreamResponse"]>;
export type ActiveContractsResponse = Response<
  components["schemas"]["JsGetActiveContractsResponse"]
>;
export type UpdatesResponse = Response<components["schemas"]["JsGetUpdatesResponse"]>;

// Constant mapping from endpoints to their JSON Schema validation paths
const SCHEMA_MAP: Record<ChannelEndpoint, string> = {
  "/v2/commands/completions": "#/components/schemas/Either_JsCantonError_CompletionStreamResponse",
  "/v2/state/active-contracts":
    "#/components/schemas/Either_JsCantonError_JsGetActiveContractsResponse",
  "/v2/updates": "#/components/schemas/Either_JsCantonError_JsGetUpdatesResponse",
  "/v2/updates/flats": "#/components/schemas/Either_JsCantonError_JsGetUpdatesResponse",
  "/v2/updates/trees": "#/components/schemas/Either_JsCantonError_JsGetUpdateTreesResponse",
} as const;

export interface StopClient {
  (): void;
}

// Type guard to check if a response is a JsCantonError
export function isCantonError(response: unknown): response is JsCantonError {
  return (
    typeof response === "object" &&
    response !== null &&
    "code" in response &&
    "cause" in response &&
    "context" in response
  );
}

export function parseStreamResponse<T>(response: T | JsCantonError): Response<T> {
  if (isCantonError(response)) {
    return { status: "error", error: response };
  }
  return { status: "success", data: response as T };
}

export function isTransaction(
  response: unknown
): response is { Transaction: components["schemas"]["Transaction"] } {
  if (
    typeof response === "object" &&
    response !== null &&
    "Transaction" in response &&
    typeof response.Transaction === "object" &&
    response.Transaction !== null &&
    "value" in response.Transaction
  ) {
    const transaction = response.Transaction as { value: unknown };
    return isJsTransaction(transaction.value);
  }
  return false;
}

export function isJsTransaction(
  response: unknown
): response is components["schemas"]["JsTransaction"] {
  return (
    typeof response === "object" &&
    response !== null &&
    "updateId" in response &&
    "commandId" in response &&
    "workflowId" in response &&
    "effectiveAt" in response &&
    "offset" in response &&
    "synchronizerId" in response &&
    "recordTime" in response
  );
}

export class WebSocketClient {
  private token: string;
  private wsBaseUrl: string;
  private validator?: SchemaValidator;

  constructor(config: StreamConfig) {
    this.token = config.token;
    this.wsBaseUrl = config.wsBaseUrl;
    this.validator = config.validation
      ? new SchemaValidator("asyncapi", config.validation)
      : undefined;
  }

  /**
   * Get the current token (for logging and validation purposes)
   */
  getToken(): string {
    return this.token;
  }

  /**
   * Update the token used for authentication
   * Note: This only updates the stored token. Active connections need to be recreated.
   */
  setToken(newToken: string): void {
    this.token = newToken;
  }

  /**
   * Generic streaming method with full type safety
   * This method enforces that request/response types match the endpoint
   */
  private stream<T extends ChannelEndpoint>(
    endpoint: T,
    request: EndpointRequestType<T>,
    onMessage: (message: EndpointResponseType<T>) => void,
    onError?: (error: Error) => void,
    onClose?: (code: number, reason: string) => void
  ): StopClient {
    const ws = this.createWebSocket(endpoint);

    ws.onopen = () => {
      logger.debug(`Opening websocket for ${endpoint}: `, { request });
      ws.send(JSON.stringify(request));
    };

    ws.onmessage = async (event: WebSocket.MessageEvent) => {
      try {
        const parsed = JSON.parse(event.data.toString());
        logger.debug(`Received message for ${endpoint}: `, { parsed });

        let message = this.validator
          ? await this.validator.validateSchema<EndpointResponseType<T>>(
              parsed,
              SCHEMA_MAP[endpoint]
            )
          : (parsed as EndpointResponseType<T>);

        onMessage(message);
      } catch (error) {
        onError?.(new Error(`Failed to parse message for ${endpoint}: ${error}`));
      }
    };

    ws.onerror = (event: WebSocket.ErrorEvent) => {
      const errorMsg = `WebSocket error ${event.type}, message: ${event.message}`;
      onError?.(new Error(`WebSocket error: ${errorMsg}`));
    };

    ws.onclose = (closeEvent: WebSocket.CloseEvent) => {
      logger.debug(`WebSocket closed for ${endpoint}: `, {
        code: closeEvent.code,
        reason: closeEvent.reason,
      });
      onClose?.(closeEvent.code, closeEvent.reason);
    };

    return () => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    };
  }

  private createWebSocket<T extends ChannelEndpoint>(endpoint: T): WebSocket {
    const baseUrl = this.wsBaseUrl.endsWith("/") ? this.wsBaseUrl : `${this.wsBaseUrl}/`;
    const url = endpoint.startsWith("/")
      ? `${baseUrl}${endpoint.slice(1)}`
      : `${baseUrl}/${endpoint}`;
    
    // Log token expiration info before connecting
    logTokenExpiration(this.token, `WebSocket connection to ${endpoint}`);
    
    // WebSocket authentication via Sec-WebSocket-Protocol header
    const protocols = [`jwt.token.${this.token}`, "daml.ws.auth"];
    logger.debug(`Connecting websocket to ${url} with protocols: ${protocols}`);

    return new WebSocket(url, protocols);
  }

  /**
   * Stream command completions in real-time
   */
  streamCompletions(
    request: CompletionStreamRequest,
    onMessage: (message: CompletionResponse) => void,
    onError?: (error: Error) => void,
    onClose?: (code: number, reason: string) => void
  ): StopClient {
    return this.stream(
      "/v2/commands/completions",
      request,
      rawMessage =>
        onMessage(
          parseStreamResponse<components["schemas"]["CompletionStreamResponse"]>(rawMessage)
        ),
      onError,
      onClose
    );
  }

  /**
   * Stream active contracts
   */
  streamActiveContracts(
    request: ActiveContractsStreamRequest,
    onMessage: (message: ActiveContractsResponse) => void,
    onError?: (error: Error) => void,
    onClose?: (code: number, reason: string) => void
  ): StopClient {
    return this.stream(
      "/v2/state/active-contracts",
      request,
      rawMessage =>
        onMessage(
          parseStreamResponse<components["schemas"]["JsGetActiveContractsResponse"]>(rawMessage)
        ),
      onError,
      onClose
    );
  }

  /**
   * Stream all ledger updates
   */
  streamUpdates(
    request: UpdatesStreamRequest,
    onMessage: (message: UpdatesResponse) => void,
    onError?: (error: Error) => void,
    onClose?: (code: number, reason: string) => void
  ): StopClient {
    return this.stream(
      "/v2/updates",
      request,
      rawMessage =>
        onMessage(parseStreamResponse<components["schemas"]["JsGetUpdatesResponse"]>(rawMessage)),
      onError,
      onClose
    );
  }
}
