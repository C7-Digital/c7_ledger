/**
 * Low-level HTTP client for Canton's OpenAPI v2 JSON API
 *
 * This client provides direct, type-safe access to the raw OpenAPI endpoints
 * with minimal abstraction. It handles authentication and request/response
 * serialization but preserves the original API structure and data types.
 *
 * Use this when you need full control over the API calls or access to
 * endpoints not covered by the higher-level Ledger abstraction.
 */
import { paths, operations } from "./generated/api";
import { SchemaValidator, ValidationMode } from "./validation";
import { isCantonError, type JsCantonError } from "./types";
import fetch from "cross-fetch";

/**
 * Error thrown when the Canton ledger API returns a non-OK HTTP response.
 * Captures the HTTP status, status text, and — when the response body
 * is a JsCantonError — the structured error details from Canton.
 */
export class LedgerApiError extends Error {
  public readonly status: number;
  public readonly statusText: string;
  public readonly cantonError?: JsCantonError;
  public readonly responseBody?: unknown;

  constructor(
    status: number,
    statusText: string,
    body?: unknown,
  ) {
    const cantonErr = isCantonError(body) ? body : undefined;
    const detail = cantonErr
      ? `${cantonErr.code}: ${cantonErr.cause}`
      : (typeof body === "string" ? body : undefined);
    const message = detail
      ? `HTTP ${status}: ${statusText} — ${detail}`
      : `HTTP ${status}: ${statusText}`;

    super(message);
    this.name = "LedgerApiError";
    this.status = status;
    this.statusText = statusText;
    this.cantonError = cantonErr;
    this.responseBody = body;
  }
}

// Extract request/response types for specific operations
type SubmitAndWaitOperation = operations["postV2CommandsSubmit-and-wait"];
type SubmitAndWaitRequest = SubmitAndWaitOperation["requestBody"]["content"]["application/json"];
type SubmitAndWaitResponse =
  SubmitAndWaitOperation["responses"]["200"]["content"]["application/json"];

type SubmitAndWaitForTransactionOperation =
  operations["postV2CommandsSubmit-and-wait-for-transaction"];
type SubmitAndWaitForTransactionRequest =
  SubmitAndWaitForTransactionOperation["requestBody"]["content"]["application/json"];
type SubmitAndWaitForTransactionResponse =
  SubmitAndWaitForTransactionOperation["responses"]["200"]["content"]["application/json"];

type GetPartiesOperation = operations["getV2Parties"];
type GetPartiesResponse = GetPartiesOperation["responses"]["200"]["content"]["application/json"];

type GetUserOperation = operations["getV2UsersUser-id"];
type GetUserResponse = GetUserOperation["responses"]["200"]["content"]["application/json"];

type GetUserRightsOperation = operations["getV2UsersUser-idRights"];
type GetUserRightsResponse =
  GetUserRightsOperation["responses"]["200"]["content"]["application/json"];

type QueryActiveContractsOperation = operations["postV2StateActive-contracts"];
type QueryActiveContractsRequest =
  QueryActiveContractsOperation["requestBody"]["content"]["application/json"];
type QueryActiveContractsResponse =
  QueryActiveContractsOperation["responses"]["200"]["content"]["application/json"];

type AllocatePartyOperation = operations["postV2Parties"];
type AllocatePartyRequest = AllocatePartyOperation["requestBody"]["content"]["application/json"];
type AllocatePartyResponse =
  AllocatePartyOperation["responses"]["200"]["content"]["application/json"];

type GetLedgerEndOperation = operations["getV2StateLedger-end"];
type GetLedgerEndResponse =
  GetLedgerEndOperation["responses"]["200"]["content"]["application/json"];

export type transaction_shape = "TRANSACTION_SHAPE_ACS_DELTA" | "TRANSACTION_SHAPE_LEDGER_EFFECTS";

export interface TypedHttpClientConfig {
  token: string;
  baseUrl: string;
  validation?: ValidationMode;
  openApiSchemaPath?: string;
  /**
   * Artificial delay in milliseconds added before returning HTTP responses.
   * Useful for simulating slow ledger interactions during local development.
   * Defaults to 0 (no delay).
   */
  responseDelay?: number;
}

export class TypedHttpClient {
  public token: string;
  public readonly baseUrl: string;
  private validator?: SchemaValidator;
  private responseDelay: number;

  constructor(config: TypedHttpClientConfig) {
    this.token = config.token;
    this.baseUrl = config.baseUrl;
    this.validator = config.validation
      ? new SchemaValidator("openapi", config.validation)
      : undefined;
    this.responseDelay = config.responseDelay ?? 0;
  }

  private async request<TResponse>(
    path: keyof paths,
    method: "GET" | "POST" | "PUT" | "DELETE",
    body?: unknown,
    responseSchemaName?: string,
    isArrayResponse?: boolean
  ): Promise<TResponse> {
    const url = `${this.baseUrl}${path}`;
    const requestInit: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
    };

    if (body) {
      requestInit.body = JSON.stringify(body);
    }

    const response = await fetch(url, requestInit);

    if (!response.ok) {
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        try {
          body = await response.text();
        } catch {
          // Response body unreadable — leave undefined
        }
      }
      throw new LedgerApiError(response.status, response.statusText, body);
    }

    const parsed = await response.json();

    if (this.responseDelay > 0) {
      await new Promise(resolve => setTimeout(resolve, this.responseDelay));
    }

    if (this.validator && responseSchemaName) {
      if (isArrayResponse) {
        return this.validator.validateArraySchema<any>(parsed, responseSchemaName) as TResponse;
      } else {
        return this.validator.validateSchema<TResponse>(parsed, responseSchemaName);
      }
    }

    return parsed as TResponse;
  }

  /** @throws {LedgerApiError} on non-OK HTTP response from the ledger */
  async submitAndWait(commands: SubmitAndWaitRequest): Promise<SubmitAndWaitResponse> {
    return this.request<SubmitAndWaitResponse>(
      "/v2/commands/submit-and-wait",
      "POST",
      commands,
      "#/components/schemas/SubmitAndWaitResponse"
    );
  }

  /** @throws {LedgerApiError} on non-OK HTTP response from the ledger */
  async submitAndWaitForTransaction(
    commands: SubmitAndWaitForTransactionRequest
  ): Promise<SubmitAndWaitForTransactionResponse> {
    return this.request<SubmitAndWaitForTransactionResponse>(
      "/v2/commands/submit-and-wait-for-transaction",
      "POST",
      commands,
      "#/components/schemas/JsSubmitAndWaitForTransactionResponse"
    );
  }

  /** @throws {LedgerApiError} on non-OK HTTP response from the ledger */
  async getParties(): Promise<GetPartiesResponse> {
    return this.request<GetPartiesResponse>(
      "/v2/parties",
      "GET",
      undefined,
      "#/components/schemas/GetPartiesResponse"
    );
  }

  /** @throws {LedgerApiError} on non-OK HTTP response from the ledger */
  async getUserInfo(userId: string): Promise<GetUserResponse> {
    return this.request<GetUserResponse>(
      `/v2/users/${userId}` as keyof paths,
      "GET",
      undefined,
      "#/components/schemas/GetUserResponse"
    );
  }

  /** @throws {LedgerApiError} on non-OK HTTP response from the ledger */
  async getUserRights(userId: string): Promise<GetUserRightsResponse> {
    return this.request<GetUserRightsResponse>(
      `/v2/users/${userId}/rights` as keyof paths,
      "GET",
      undefined,
      "#/components/schemas/ListUserRightsResponse"
    );
  }

  /** @throws {LedgerApiError} on non-OK HTTP response from the ledger */
  async queryActiveContracts(
    queryRequest: QueryActiveContractsRequest
  ): Promise<QueryActiveContractsResponse> {
    return this.request<QueryActiveContractsResponse>(
      "/v2/state/active-contracts",
      "POST",
      queryRequest,
      "#/components/schemas/JsGetActiveContractsResponse",
      true
    );
  }

  /** @throws {LedgerApiError} on non-OK HTTP response from the ledger */
  async allocateParty(request: AllocatePartyRequest): Promise<AllocatePartyResponse> {
    return this.request<AllocatePartyResponse>(
      "/v2/parties",
      "POST",
      request,
      "#/components/schemas/AllocatePartyResponse"
    );
  }

  /** @throws {LedgerApiError} on non-OK HTTP response from the ledger */
  async getLedgerEnd(): Promise<GetLedgerEndResponse> {
    return this.request<GetLedgerEndResponse>(
      "/v2/state/ledger-end",
      "GET",
      undefined,
      "#/components/schemas/GetLedgerEndResponse"
    );
  }
}
