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
import fetch from "cross-fetch";

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
}

export class TypedHttpClient {
  public readonly token: string;
  public readonly baseUrl: string;
  private validator?: SchemaValidator;

  constructor(config: TypedHttpClientConfig) {
    this.token = config.token;
    this.baseUrl = config.baseUrl;
    this.validator = config.validation
      ? new SchemaValidator("openapi", config.validation)
      : undefined;
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
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const parsed = await response.json();

    if (this.validator && responseSchemaName) {
      if (isArrayResponse) {
        return this.validator.validateArraySchema<any>(parsed, responseSchemaName) as TResponse;
      } else {
        return this.validator.validateSchema<TResponse>(parsed, responseSchemaName);
      }
    }

    return parsed as TResponse;
  }

  async submitAndWait(commands: SubmitAndWaitRequest): Promise<SubmitAndWaitResponse> {
    return this.request<SubmitAndWaitResponse>(
      "/v2/commands/submit-and-wait",
      "POST",
      commands,
      "#/components/schemas/SubmitAndWaitResponse"
    );
  }

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

  async getParties(): Promise<GetPartiesResponse> {
    return this.request<GetPartiesResponse>(
      "/v2/parties",
      "GET",
      undefined,
      "#/components/schemas/GetPartiesResponse"
    );
  }

  async getUserInfo(userId: string): Promise<GetUserResponse> {
    return this.request<GetUserResponse>(
      `/v2/users/${userId}` as keyof paths,
      "GET",
      undefined,
      "#/components/schemas/GetUserResponse"
    );
  }

  async getUserRights(userId: string): Promise<GetUserRightsResponse> {
    return this.request<GetUserRightsResponse>(
      `/v2/users/${userId}/rights` as keyof paths,
      "GET",
      undefined,
      "#/components/schemas/ListUserRightsResponse"
    );
  }

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

  async allocateParty(request: AllocatePartyRequest): Promise<AllocatePartyResponse> {
    return this.request<AllocatePartyResponse>(
      "/v2/parties",
      "POST",
      request,
      "#/components/schemas/AllocatePartyResponse"
    );
  }

  async getLedgerEnd(): Promise<GetLedgerEndResponse> {
    return this.request<GetLedgerEndResponse>(
      "/v2/state/ledger-end",
      "GET",
      undefined,
      "#/components/schemas/GetLedgerEndResponse"
    );
  }
}
