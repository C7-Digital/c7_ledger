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
import { Party } from "@daml/types";

import { paths, operations } from "./generated/api";
import { SchemaValidator, ValidationMode } from "./validation";
import { isCantonError, type JsCantonError } from "./types";

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

type CreateUserOperation = operations["postV2Users"];
type CreateUserRequest = CreateUserOperation["requestBody"]["content"]["application/json"];
type CreateUserResponse =
  CreateUserOperation["responses"]["200"]["content"]["application/json"];

type GetLedgerEndOperation = operations["getV2StateLedger-end"];
type GetLedgerEndResponse =
  GetLedgerEndOperation["responses"]["200"]["content"]["application/json"];

type PrepareSubmissionOperation = operations["postV2Interactive-submissionPrepare"];
type PrepareSubmissionRequest =
  PrepareSubmissionOperation["requestBody"]["content"]["application/json"];
type PrepareSubmissionResponse =
  PrepareSubmissionOperation["responses"]["200"]["content"]["application/json"];

type GetConnectedSynchronizersOperation = operations["getV2StateConnected-synchronizers"];
type GetConnectedSynchronizersResponse =
  GetConnectedSynchronizersOperation["responses"]["200"]["content"]["application/json"];

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
    const responseDelay = config.responseDelay;
    this.responseDelay =
      responseDelay !== undefined && Number.isFinite(responseDelay)
        ? Math.max(0, Math.floor(responseDelay))
        : 0;
  }

  private async request<TResponse>(
    path: keyof paths,
    method: "GET" | "POST" | "PUT" | "DELETE",
    body?: unknown,
    responseSchemaName?: string,
    isArrayResponse?: boolean,
    queryParams?: Record<string, string | number | boolean | undefined>
  ): Promise<TResponse> {
    // Some Canton JSON API endpoints (notably `POST /v2/state/active-contracts`
    // and the paged updates) take control knobs as URL query parameters —
    // `limit`, `stream_idle_timeout_ms` — rather than in the body. The upstream
    // OpenAPI export omits those from the path spec (see api.ts `query?: never`
    // on the ACS path), so consumers pass them through this optional map.
    const url =
      queryParams && Object.keys(queryParams).length > 0
        ? `${this.baseUrl}${path}?${new URLSearchParams(
            Object.entries(queryParams).flatMap(([k, v]) =>
              v === undefined ? [] : [[k, String(v)] as [string, string]]
            )
          ).toString()}`
        : `${this.baseUrl}${path}`;
    const requestInit: RequestInit = {
      method,
      // Bearer-token API — explicitly tell the browser NOT to attach
      // cookies for the destination origin. Default `credentials` is
      // `"same-origin"`, which silently stamps every cookie the page
      // origin holds onto the request. Some deployments terminate the
      // JSON Ledger API behind a gateway that shares an origin with
      // the UI and sets session-affinity / sticky cookies (envoy,
      // istio, helm ingresses); those cookies pile up and eventually
      // overflow nginx's `large_client_header_buffers`, producing a
      // 400 "Request Header Or Cookie Too Large". No JSON Ledger API
      // consumer authenticates via cookies — JWT only — so `"omit"`
      // is unambiguously correct here.
      credentials: "omit",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
    };

    if (body) {
      requestInit.body = JSON.stringify(body);
    }

    const response = await fetch(url, requestInit);

    if (this.responseDelay > 0) {
      await new Promise(resolve => setTimeout(resolve, this.responseDelay));
    }

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

  /**
   * Query the active contract set at a given offset.
   *
   * `options.limit` caps the number of returned rows (URL query param the
   * OpenAPI export doesn't surface). Canton enforces `min(limit, http-list-
   * max-elements-limit + 1)` — pass a limit at or below the participant's
   * `http-list-max-elements-limit` (default 200) and the call succeeds even
   * when the ACS slice is much larger; the response is silently truncated to
   * that limit with no page token, so use this only when a bounded prefix is
   * acceptable (e.g. an aggregate summed over the truncated slice).
   *
   * @throws {LedgerApiError} on non-OK HTTP response from the ledger
   */
  async queryActiveContracts(
    queryRequest: QueryActiveContractsRequest,
    options?: { limit?: number }
  ): Promise<QueryActiveContractsResponse> {
    return this.request<QueryActiveContractsResponse>(
      "/v2/state/active-contracts",
      "POST",
      queryRequest,
      "#/components/schemas/JsGetActiveContractsResponse",
      true,
      options?.limit !== undefined ? { limit: options.limit } : undefined
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
  async createUser(request: CreateUserRequest): Promise<CreateUserResponse> {
    return this.request<CreateUserResponse>(
      "/v2/users",
      "POST",
      request,
      "#/components/schemas/CreateUserResponse"
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

  /**
   * List the synchronizers this participant is connected to.
   * Filterable by `party` and/or `participantId` per the JSON Ledger API spec.
   * @throws {LedgerApiError} on non-OK HTTP response from the ledger
   */
  async getConnectedSynchronizers(
    party?: Party,
    participantId?: string,
    identityProviderId?: string,
  ): Promise<GetConnectedSynchronizersResponse> {
    const qs = new URLSearchParams();
    if (party) qs.set("party", party);
    if (participantId) qs.set("participantId", participantId);
    if (identityProviderId) qs.set("identityProviderId", identityProviderId);
    const path = qs.toString()
      ? (`/v2/state/connected-synchronizers?${qs.toString()}` as keyof paths)
      : ("/v2/state/connected-synchronizers" as keyof paths);
    return this.request<GetConnectedSynchronizersResponse>(
      path,
      "GET",
      undefined,
      "#/components/schemas/GetConnectedSynchronizersResponse",
    );
  }

  /**
   * Prepare a transaction for interactive submission.
   * Returns cost estimation and a prepared transaction blob.
   * @throws {LedgerApiError} on non-OK HTTP response from the ledger
   */
  async prepareSubmission(
    request: PrepareSubmissionRequest,
  ): Promise<PrepareSubmissionResponse> {
    return this.request<PrepareSubmissionResponse>(
      "/v2/interactive-submission/prepare",
      "POST",
      request,
      "#/components/schemas/JsPrepareSubmissionResponse",
    );
  }
}
