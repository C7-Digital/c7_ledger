/**
 * Typed HTTP client for the Canton Network Scan API.
 *
 * Provides type-safe access to the Scan API endpoints for discovering
 * party metadata, ANS entries, validator licenses, DSO info, and more.
 */
import { operations } from "./generated/api";
import { logger } from "./logger";
import fetch from "cross-fetch";

// ─── ANS / Name Service ────────────────────────────────────────────────

type ListAnsEntriesOperation = operations["listAnsEntries"];
type ListAnsEntriesParams = ListAnsEntriesOperation["parameters"]["query"];
type ListAnsEntriesResponse =
  ListAnsEntriesOperation["responses"]["200"]["content"]["application/json"];

type LookupAnsEntryByPartyOperation = operations["lookupAnsEntryByParty"];
type LookupAnsEntryByPartyResponse =
  LookupAnsEntryByPartyOperation["responses"]["200"]["content"]["application/json"];

type LookupAnsEntryByNameOperation = operations["lookupAnsEntryByName"];
type LookupAnsEntryByNameResponse =
  LookupAnsEntryByNameOperation["responses"]["200"]["content"]["application/json"];

// ─── Party Resolution ──────────────────────────────────────────────────

type GetPartyToParticipantOperation = operations["getPartyToParticipant"];
type GetPartyToParticipantResponse =
  GetPartyToParticipantOperation["responses"]["200"]["content"]["application/json"];

// ─── Network Info ──────────────────────────────────────────────────────

type GetDsoInfoOperation = operations["getDsoInfo"];
type GetDsoInfoResponse =
  GetDsoInfoOperation["responses"]["200"]["content"]["application/json"];

type GetDsoPartyIdOperation = operations["getDsoPartyId"];
type GetDsoPartyIdResponse =
  GetDsoPartyIdOperation["responses"]["200"]["content"]["application/json"];

type ListDsoSequencersOperation = operations["listDsoSequencers"];
type ListDsoSequencersResponse =
  ListDsoSequencersOperation["responses"]["200"]["content"]["application/json"];

type ListDsoScansOperation = operations["listDsoScans"];
type ListDsoScansResponse =
  ListDsoScansOperation["responses"]["200"]["content"]["application/json"];

// ─── Validator Info ────────────────────────────────────────────────────

type ListValidatorLicensesOperation = operations["listValidatorLicenses"];
type ListValidatorLicensesParams = ListValidatorLicensesOperation["parameters"]["query"];
type ListValidatorLicensesResponse =
  ListValidatorLicensesOperation["responses"]["200"]["content"]["application/json"];

type GetValidatorFaucetsOperation = operations["getValidatorFaucetsByValidator"];
type GetValidatorFaucetsParams = GetValidatorFaucetsOperation["parameters"]["query"];
type GetValidatorFaucetsResponse =
  GetValidatorFaucetsOperation["responses"]["200"]["content"]["application/json"];

// ─── Updates (v2) ──────────────────────────────────────────────────────

type GetUpdatesV2Operation = operations["getUpdateHistoryV2"];
type GetUpdatesV2Request =
  GetUpdatesV2Operation["requestBody"]["content"]["application/json"];
type GetUpdatesV2Response =
  GetUpdatesV2Operation["responses"]["200"]["content"]["application/json"];

type GetUpdateByIdV2Operation = operations["getUpdateByIdV2"];
type GetUpdateByIdV2Params = GetUpdateByIdV2Operation["parameters"]["query"];
type GetUpdateByIdV2Response =
  GetUpdateByIdV2Operation["responses"]["200"]["content"]["application/json"];

// ─── ACS State ─────────────────────────────────────────────────────────

type GetAcsSnapshotOperation = operations["getAcsSnapshotAt"];
type GetAcsSnapshotRequest =
  GetAcsSnapshotOperation["requestBody"]["content"]["application/json"];
type GetAcsSnapshotResponse =
  GetAcsSnapshotOperation["responses"]["200"]["content"]["application/json"];

type GetAcsSnapshotTimestampOperation = operations["getDateOfMostRecentSnapshotBefore"];
type GetAcsSnapshotTimestampParams = GetAcsSnapshotTimestampOperation["parameters"]["query"];
type GetAcsSnapshotTimestampResponse =
  GetAcsSnapshotTimestampOperation["responses"]["200"]["content"]["application/json"];

type GetAcsSnapshotTimestampAfterOperation = operations["getDateOfFirstSnapshotAfter"];
type GetAcsSnapshotTimestampAfterParams = GetAcsSnapshotTimestampAfterOperation["parameters"]["query"];
type GetAcsSnapshotTimestampAfterResponse =
  GetAcsSnapshotTimestampAfterOperation["responses"]["200"]["content"]["application/json"];

type ForceAcsSnapshotOperation = operations["forceAcsSnapshotNow"];
type ForceAcsSnapshotResponse =
  ForceAcsSnapshotOperation["responses"]["200"]["content"]["application/json"];

// ─── Holdings ──────────────────────────────────────────────────────────

type GetHoldingsStateOperation = operations["getHoldingsStateAt"];
type GetHoldingsStateRequest =
  GetHoldingsStateOperation["requestBody"]["content"]["application/json"];
type GetHoldingsStateResponse =
  GetHoldingsStateOperation["responses"]["200"]["content"]["application/json"];

type GetHoldingsSummaryOperation = operations["getHoldingsSummaryAt"];
type GetHoldingsSummaryRequest =
  GetHoldingsSummaryOperation["requestBody"]["content"]["application/json"];
type GetHoldingsSummaryResponse =
  GetHoldingsSummaryOperation["responses"]["200"]["content"]["application/json"];

// ─── Rounds ────────────────────────────────────────────────────────────

type GetClosedRoundsOperation = operations["getClosedRounds"];
type GetClosedRoundsResponse =
  GetClosedRoundsOperation["responses"]["200"]["content"]["application/json"];

type GetOpenAndIssuingMiningRoundsOperation = operations["getOpenAndIssuingMiningRounds"];
type GetOpenAndIssuingMiningRoundsRequest =
  GetOpenAndIssuingMiningRoundsOperation["requestBody"]["content"]["application/json"];
type GetOpenAndIssuingMiningRoundsResponse =
  GetOpenAndIssuingMiningRoundsOperation["responses"]["200"]["content"]["application/json"];

// ─── Events ────────────────────────────────────────────────────────────

type GetEventsOperation = operations["getEventHistory"];
type GetEventsRequest =
  GetEventsOperation["requestBody"]["content"]["application/json"];
type GetEventsResponse =
  GetEventsOperation["responses"]["200"]["content"]["application/json"];

type GetEventByIdOperation = operations["getEventById"];
type GetEventByIdParams = GetEventByIdOperation["parameters"]["query"];
type GetEventByIdResponse =
  GetEventByIdOperation["responses"]["200"]["content"]["application/json"];

// ─── Misc ──────────────────────────────────────────────────────────────

type ListUnclaimedDevelopmentFundCouponsOperation = operations["listUnclaimedDevelopmentFundCoupons"];
type ListUnclaimedDevelopmentFundCouponsResponse =
  ListUnclaimedDevelopmentFundCouponsOperation["responses"]["200"]["content"]["application/json"];

type GetHealthStatusOperation = operations["getHealthStatus"];
type GetHealthStatusResponse =
  GetHealthStatusOperation["responses"]["200"]["content"]["application/json"];

type GetVersionOperation = operations["getVersion"];
type GetVersionResponse =
  GetVersionOperation["responses"]["200"]["content"]["application/json"];

// ─── Client Config ─────────────────────────────────────────────────────

export interface ScanClientConfig {
  /** Base URL of the Scan API, e.g. "https://scan.example.com/api/scan" */
  baseUrl: string;
  /** Optional bearer token for authenticated endpoints */
  token?: string;
}

// ─── ScanClient ────────────────────────────────────────────────────────

export class ScanClient {
  public readonly baseUrl: string;
  public readonly token?: string;

  constructor(config: ScanClientConfig) {
    this.baseUrl = config.baseUrl;
    this.token = config.token;
  }

  private async request<TResponse>(
    path: string,
    method: "GET" | "POST",
    options?: {
      body?: unknown;
      query?: Record<string, unknown>;
    },
  ): Promise<TResponse> {
    let url = `${this.baseUrl}${path}`;

    // Append query parameters
    if (options?.query) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(options.query)) {
        if (value === undefined || value === null) continue;
        if (Array.isArray(value)) {
          for (const item of value) {
            params.append(key, String(item));
          }
        } else {
          params.append(key, String(value));
        }
      }
      const qs = params.toString();
      if (qs) {
        url += `?${qs}`;
      }
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.token) {
      headers["Authorization"] = `Bearer ${this.token}`;
    }

    const requestInit: RequestInit = { method, headers };
    if (options?.body) {
      requestInit.body = JSON.stringify(options.body);
    }

    logger.debug(`${method} ${url}`);
    const response = await fetch(url, requestInit);

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status}: ${response.statusText}${text ? ` - ${text}` : ""}`);
    }

    // Some health endpoints return empty bodies
    const contentType = response.headers.get("content-type");
    if (!contentType || !contentType.includes("application/json")) {
      return undefined as unknown as TResponse;
    }

    return (await response.json()) as TResponse;
  }

  // ─── ANS / Name Service ────────────────────────────────────────────

  async listAnsEntries(params: ListAnsEntriesParams): Promise<ListAnsEntriesResponse> {
    return this.request<ListAnsEntriesResponse>("/v0/ans-entries", "GET", {
      query: params as Record<string, unknown>,
    });
  }

  async lookupAnsEntryByParty(party: string): Promise<LookupAnsEntryByPartyResponse> {
    return this.request<LookupAnsEntryByPartyResponse>(
      `/v0/ans-entries/by-party/${encodeURIComponent(party)}`,
      "GET",
    );
  }

  async lookupAnsEntryByName(name: string): Promise<LookupAnsEntryByNameResponse> {
    return this.request<LookupAnsEntryByNameResponse>(
      `/v0/ans-entries/by-name/${encodeURIComponent(name)}`,
      "GET",
    );
  }

  // ─── Party Resolution ──────────────────────────────────────────────

  async getPartyToParticipant(
    domainId: string,
    partyId: string,
  ): Promise<GetPartyToParticipantResponse> {
    return this.request<GetPartyToParticipantResponse>(
      `/v0/domains/${encodeURIComponent(domainId)}/parties/${encodeURIComponent(partyId)}/participant-id`,
      "GET",
    );
  }

  // ─── Network Info ──────────────────────────────────────────────────

  async getDsoInfo(): Promise<GetDsoInfoResponse> {
    return this.request<GetDsoInfoResponse>("/v0/dso", "GET");
  }

  async getDsoPartyId(): Promise<GetDsoPartyIdResponse> {
    return this.request<GetDsoPartyIdResponse>("/v0/dso-party-id", "GET");
  }

  async getDsoSequencers(): Promise<ListDsoSequencersResponse> {
    return this.request<ListDsoSequencersResponse>("/v0/dso-sequencers", "GET");
  }

  async listScans(): Promise<ListDsoScansResponse> {
    return this.request<ListDsoScansResponse>("/v0/scans", "GET");
  }

  // ─── Validator Info ────────────────────────────────────────────────

  async listValidatorLicenses(
    params?: ListValidatorLicensesParams,
  ): Promise<ListValidatorLicensesResponse> {
    return this.request<ListValidatorLicensesResponse>(
      "/v0/admin/validator/licenses",
      "GET",
      { query: params as Record<string, unknown> | undefined },
    );
  }

  async getValidatorFaucets(
    params: GetValidatorFaucetsParams,
  ): Promise<GetValidatorFaucetsResponse> {
    return this.request<GetValidatorFaucetsResponse>(
      "/v0/validators/validator-faucets",
      "GET",
      { query: params as Record<string, unknown> },
    );
  }

  // ─── Updates (v2) ──────────────────────────────────────────────────

  async getUpdates(body: GetUpdatesV2Request): Promise<GetUpdatesV2Response> {
    return this.request<GetUpdatesV2Response>("/v2/updates", "POST", { body });
  }

  async getUpdateById(
    updateId: string,
    params?: GetUpdateByIdV2Params,
  ): Promise<GetUpdateByIdV2Response> {
    return this.request<GetUpdateByIdV2Response>(
      `/v2/updates/${encodeURIComponent(updateId)}`,
      "GET",
      { query: params as Record<string, unknown> | undefined },
    );
  }

  // ─── ACS State ─────────────────────────────────────────────────────

  async getAcsSnapshot(body: GetAcsSnapshotRequest): Promise<GetAcsSnapshotResponse> {
    return this.request<GetAcsSnapshotResponse>("/v0/state/acs", "POST", { body });
  }

  async getAcsSnapshotTimestamp(
    params: GetAcsSnapshotTimestampParams,
  ): Promise<GetAcsSnapshotTimestampResponse> {
    return this.request<GetAcsSnapshotTimestampResponse>(
      "/v0/state/acs/snapshot-timestamp",
      "GET",
      { query: params as Record<string, unknown> },
    );
  }

  async getAcsSnapshotTimestampAfter(
    params: GetAcsSnapshotTimestampAfterParams,
  ): Promise<GetAcsSnapshotTimestampAfterResponse> {
    return this.request<GetAcsSnapshotTimestampAfterResponse>(
      "/v0/state/acs/snapshot-timestamp-after",
      "GET",
      { query: params as Record<string, unknown> },
    );
  }

  async forceAcsSnapshot(): Promise<ForceAcsSnapshotResponse> {
    return this.request<ForceAcsSnapshotResponse>(
      "/v0/state/acs/force",
      "POST",
    );
  }

  // ─── Holdings ──────────────────────────────────────────────────────

  async getHoldingsState(body: GetHoldingsStateRequest): Promise<GetHoldingsStateResponse> {
    return this.request<GetHoldingsStateResponse>("/v0/holdings/state", "POST", { body });
  }

  async getHoldingsSummary(body: GetHoldingsSummaryRequest): Promise<GetHoldingsSummaryResponse> {
    return this.request<GetHoldingsSummaryResponse>("/v0/holdings/summary", "POST", { body });
  }

  // ─── Rounds ────────────────────────────────────────────────────────

  async getClosedRounds(): Promise<GetClosedRoundsResponse> {
    return this.request<GetClosedRoundsResponse>("/v0/closed-rounds", "GET");
  }

  async getOpenAndIssuingMiningRounds(
    body: GetOpenAndIssuingMiningRoundsRequest,
  ): Promise<GetOpenAndIssuingMiningRoundsResponse> {
    return this.request<GetOpenAndIssuingMiningRoundsResponse>(
      "/v0/open-and-issuing-mining-rounds",
      "POST",
      { body },
    );
  }

  // ─── Events ────────────────────────────────────────────────────────

  async getEvents(body: GetEventsRequest): Promise<GetEventsResponse> {
    return this.request<GetEventsResponse>("/v0/events", "POST", { body });
  }

  async getEventById(
    updateId: string,
    params?: GetEventByIdParams,
  ): Promise<GetEventByIdResponse> {
    return this.request<GetEventByIdResponse>(
      `/v0/events/${encodeURIComponent(updateId)}`,
      "GET",
      { query: params as Record<string, unknown> | undefined },
    );
  }

  // ─── Misc ──────────────────────────────────────────────────────────

  async getUnclaimedDevelopmentFundCoupons(): Promise<ListUnclaimedDevelopmentFundCouponsResponse> {
    return this.request<ListUnclaimedDevelopmentFundCouponsResponse>(
      "/v0/unclaimed-development-fund-coupons",
      "GET",
    );
  }

  // ─── Health ────────────────────────────────────────────────────────

  async isReady(): Promise<boolean> {
    try {
      await this.request<void>("/readyz", "GET");
      return true;
    } catch {
      return false;
    }
  }

  async isLive(): Promise<boolean> {
    try {
      await this.request<void>("/livez", "GET");
      return true;
    } catch {
      return false;
    }
  }

  async getStatus(): Promise<GetHealthStatusResponse> {
    return this.request<GetHealthStatusResponse>("/status", "GET");
  }

  async getVersion(): Promise<GetVersionResponse> {
    return this.request<GetVersionResponse>("/version", "GET");
  }
}
