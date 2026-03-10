/**
 * Typed HTTP client for the Canton Network Scan API.
 *
 * Provides type-safe access to the Scan API endpoints for discovering
 * party metadata, ANS entries, validator licenses, DSO info, and more.
 */
import { Party } from "@daml/types";
import { operations, components } from "./generated/api.js";
import type * as Typed from "./types.js";
import { logger } from "./logger.js";
import fetch from "cross-fetch";

// ─── Party-refined types ──────────────────────────────────────────────
// The OpenAPI spec uses plain `string` for party identifiers. We refine
// known party fields to `Party` from @daml/types for downstream type safety.

/** ANS entry with `user` typed as Party (owner party ID). */
export type AnsEntry = Omit<components["schemas"]["AnsEntry"], "user"> & {
  user: Party;
};

// ─── ANS / Name Service ────────────────────────────────────────────────

type ListAnsEntriesOperation = operations["listAnsEntries"];
type ListAnsEntriesParams = ListAnsEntriesOperation["parameters"]["query"];
type ListAnsEntriesResponse = {
  entries: AnsEntry[];
};

type LookupAnsEntryByPartyOperation = operations["lookupAnsEntryByParty"];
type LookupAnsEntryByPartyResponse = {
  entry: AnsEntry;
};

type LookupAnsEntryByNameOperation = operations["lookupAnsEntryByName"];
type LookupAnsEntryByNameResponse = {
  entry: AnsEntry;
};

// ─── Party Resolution ──────────────────────────────────────────────────

type GetPartyToParticipantOperation = operations["getPartyToParticipant"];
type GetPartyToParticipantResponse =
  GetPartyToParticipantOperation["responses"]["200"]["content"]["application/json"];

// ─── Network Info ──────────────────────────────────────────────────────

type GetDsoInfoResponse = Typed.GetDsoInfoResponse;

type GetDsoPartyIdOperation = operations["getDsoPartyId"];
type GetDsoPartyIdResponse = {
  dso_party_id: Party;
};

type ListDsoSequencersOperation = operations["listDsoSequencers"];
type ListDsoSequencersResponse =
  ListDsoSequencersOperation["responses"]["200"]["content"]["application/json"];

type ListDsoScansOperation = operations["listDsoScans"];
type ListDsoScansResponse =
  ListDsoScansOperation["responses"]["200"]["content"]["application/json"];

// ─── Validator Info ────────────────────────────────────────────────────

type ListValidatorLicensesOperation = operations["listValidatorLicenses"];
type ListValidatorLicensesParams = ListValidatorLicensesOperation["parameters"]["query"];
type ListValidatorLicensesResponse = Typed.ListValidatorLicensesResponse;

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

type GetClosedRoundsResponse = Typed.GetClosedRoundsResponse;

type GetOpenAndIssuingMiningRoundsOperation = operations["getOpenAndIssuingMiningRounds"];
type GetOpenAndIssuingMiningRoundsRequest =
  GetOpenAndIssuingMiningRoundsOperation["requestBody"]["content"]["application/json"];
type GetOpenAndIssuingMiningRoundsResponse = Typed.GetOpenAndIssuingMiningRoundsResponse;

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

// ─── Rules & Config ────────────────────────────────────────────────────

type GetAmuletRulesOperation = operations["getAmuletRules"];
type GetAmuletRulesRequest =
  GetAmuletRulesOperation["requestBody"]["content"]["application/json"];
type GetAmuletRulesResponse = Typed.GetAmuletRulesResponse;

type GetExternalPartyAmuletRulesOperation = operations["getExternalPartyAmuletRules"];
type GetExternalPartyAmuletRulesRequest =
  GetExternalPartyAmuletRulesOperation["requestBody"]["content"]["application/json"];
type GetExternalPartyAmuletRulesResponse = Typed.GetExternalPartyAmuletRulesResponse;

type GetAnsRulesOperation = operations["getAnsRules"];
type GetAnsRulesRequest =
  GetAnsRulesOperation["requestBody"]["content"]["application/json"];
type GetAnsRulesResponse = Typed.GetAnsRulesResponse;

type GetSpliceInstanceNamesOperation = operations["getSpliceInstanceNames"];
type GetSpliceInstanceNamesResponse =
  GetSpliceInstanceNamesOperation["responses"]["200"]["content"]["application/json"];

type FeatureSupportOperation = operations["featureSupport"];
type FeatureSupportResponse =
  FeatureSupportOperation["responses"]["200"]["content"]["application/json"];

// ─── Featured Apps ─────────────────────────────────────────────────────

type ListFeaturedAppRightsResponse = Typed.ListFeaturedAppRightsResponse;
type LookupFeaturedAppRightResponse = Typed.LookupFeaturedAppRightResponse;

// ─── Validator Faucets ─────────────────────────────────────────────────

type GetTopValidatorsByValidatorFaucetsOperation = operations["getTopValidatorsByValidatorFaucets"];
type GetTopValidatorsByValidatorFaucetsParams =
  GetTopValidatorsByValidatorFaucetsOperation["parameters"]["query"];
type GetTopValidatorsByValidatorFaucetsResponse =
  GetTopValidatorsByValidatorFaucetsOperation["responses"]["200"]["content"]["application/json"];

// ─── Transfers ─────────────────────────────────────────────────────────

type LookupTransferPreapprovalByPartyResponse = Typed.LookupTransferPreapprovalByPartyResponse;
type LookupTransferCommandCounterByPartyResponse = Typed.LookupTransferCommandCounterByPartyResponse;

type LookupTransferCommandStatusOperation = operations["lookupTransferCommandStatus"];
type LookupTransferCommandStatusParams =
  LookupTransferCommandStatusOperation["parameters"]["query"];
type LookupTransferCommandStatusResponse = Typed.LookupTransferCommandStatusResponse;

// ─── Governance ────────────────────────────────────────────────────────

type ListDsoRulesVoteRequestsResponse = Typed.ListDsoRulesVoteRequestsResponse;

type ListVoteRequestResultsOperation = operations["listVoteRequestResults"];
type ListVoteRequestResultsRequest =
  ListVoteRequestResultsOperation["requestBody"]["content"]["application/json"];
type ListVoteRequestResultsResponse =
  ListVoteRequestResultsOperation["responses"]["200"]["content"]["application/json"];

type ListAmuletPriceVotesOperation = operations["listAmuletPriceVotes"];
type ListAmuletPriceVotesResponse =
  ListAmuletPriceVotesOperation["responses"]["200"]["content"]["application/json"];

// ─── Migrations ────────────────────────────────────────────────────────

type MigrationScheduleResponse =
  operations["getMigrationSchedule"]["responses"]["200"]["content"]["application/json"];

type GetMigrationInfoOperation = operations["getMigrationInfo"];
type GetMigrationInfoRequest =
  GetMigrationInfoOperation["requestBody"]["content"]["application/json"];
type GetMigrationInfoResponse =
  GetMigrationInfoOperation["responses"]["200"]["content"]["application/json"];

// ─── Infrastructure ────────────────────────────────────────────────────

type ListSvBftSequencersOperation = operations["listSvBftSequencers"];
type ListSvBftSequencersResponse =
  ListSvBftSequencersOperation["responses"]["200"]["content"]["application/json"];

type GetMemberTrafficStatusOperation = operations["getMemberTrafficStatus"];
type GetMemberTrafficStatusResponse =
  GetMemberTrafficStatusOperation["responses"]["200"]["content"]["application/json"];

type GetBackfillingStatusOperation = operations["getBackfillingStatus"];
type GetBackfillingStatusResponse =
  GetBackfillingStatusOperation["responses"]["200"]["content"]["application/json"];

// ─── Misc ──────────────────────────────────────────────────────────────

type ListUnclaimedDevelopmentFundCouponsResponse = Typed.ListUnclaimedDevelopmentFundCouponsResponse;

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
  /** Enable verbose request/response logging via the logger */
  debug?: boolean;
}

// ─── ScanClient ────────────────────────────────────────────────────────

export class ScanClient {
  public readonly baseUrl: string;
  public readonly token?: string;
  public debug: boolean;

  constructor(config: ScanClientConfig) {
    this.baseUrl = config.baseUrl;
    this.token = config.token;
    this.debug = config.debug ?? false;
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

    if (this.debug) {
      logger.info(`[scan-debug] → ${method} ${url}`);
      if (options?.body) {
        logger.info(`[scan-debug] → body: ${JSON.stringify(options.body)}`);
      }
    } else {
      logger.debug(`${method} ${url}`);
    }

    const response = await fetch(url, requestInit);

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      if (this.debug) {
        logger.error(`[scan-debug] ← ${response.status} ${response.statusText}`, text);
      }
      throw new Error(`HTTP ${response.status}: ${response.statusText}${text ? ` - ${text}` : ""}`);
    }

    // Some health endpoints return empty bodies
    const contentType = response.headers.get("content-type");
    if (!contentType || !contentType.includes("application/json")) {
      if (this.debug) {
        // Log the actual content-type and attempt to read the body for debugging
        const text = await response.text().catch(() => "");
        const bodyPreview = text.length > 2000 ? text.slice(0, 2000) + "..." : text;
        logger.warn(`[scan-debug] ← ${response.status} content-type="${contentType}" body=${bodyPreview}`);
      }
      return undefined as unknown as TResponse;
    }

    const json = (await response.json()) as TResponse;
    if (this.debug) {
      const preview = JSON.stringify(json);
      const truncated = preview.length > 2000 ? preview.slice(0, 2000) + "..." : preview;
      logger.info(`[scan-debug] ← ${response.status} ${truncated}`);
    }
    return json;
  }

  // ─── ANS / Name Service ────────────────────────────────────────────

  async listAnsEntries(params: ListAnsEntriesParams): Promise<ListAnsEntriesResponse> {
    return this.request<ListAnsEntriesResponse>("/v0/ans-entries", "GET", {
      query: params as Record<string, unknown>,
    });
  }

  async lookupAnsEntryByParty(party: Party): Promise<LookupAnsEntryByPartyResponse> {
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
    partyId: Party,
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

  // ─── Rules & Config ────────────────────────────────────────────────

  async getAmuletRules(body?: GetAmuletRulesRequest): Promise<GetAmuletRulesResponse> {
    return this.request<GetAmuletRulesResponse>("/v0/amulet-rules", "POST", {
      body: body ?? {},
    });
  }

  async getExternalPartyAmuletRules(
    body?: GetExternalPartyAmuletRulesRequest,
  ): Promise<GetExternalPartyAmuletRulesResponse> {
    return this.request<GetExternalPartyAmuletRulesResponse>(
      "/v0/external-party-amulet-rules",
      "POST",
      { body: body ?? {} },
    );
  }

  async getAnsRules(body?: GetAnsRulesRequest): Promise<GetAnsRulesResponse> {
    return this.request<GetAnsRulesResponse>("/v0/ans-rules", "POST", {
      body: body ?? {},
    });
  }

  async getSpliceInstanceNames(): Promise<GetSpliceInstanceNamesResponse> {
    return this.request<GetSpliceInstanceNamesResponse>(
      "/v0/splice-instance-names",
      "GET",
    );
  }

  async getFeatureSupport(): Promise<FeatureSupportResponse> {
    return this.request<FeatureSupportResponse>("/v0/feature-support", "GET");
  }

  // ─── Featured Apps ────────────────────────────────────────────────

  async listFeaturedAppRights(): Promise<ListFeaturedAppRightsResponse> {
    return this.request<ListFeaturedAppRightsResponse>("/v0/featured-apps", "GET");
  }

  async lookupFeaturedAppRight(providerPartyId: Party): Promise<LookupFeaturedAppRightResponse> {
    return this.request<LookupFeaturedAppRightResponse>(
      `/v0/featured-apps/${encodeURIComponent(providerPartyId)}`,
      "GET",
    );
  }

  // ─── Validator Faucets ────────────────────────────────────────────

  async getTopValidatorsByValidatorFaucets(
    params: GetTopValidatorsByValidatorFaucetsParams,
  ): Promise<GetTopValidatorsByValidatorFaucetsResponse> {
    return this.request<GetTopValidatorsByValidatorFaucetsResponse>(
      "/v0/top-validators-by-validator-faucets",
      "GET",
      { query: params as Record<string, unknown> },
    );
  }

  // ─── Transfers ────────────────────────────────────────────────────

  async lookupTransferPreapprovalByParty(
    party: Party,
  ): Promise<LookupTransferPreapprovalByPartyResponse> {
    return this.request<LookupTransferPreapprovalByPartyResponse>(
      `/v0/transfer-preapprovals/by-party/${encodeURIComponent(party)}`,
      "GET",
    );
  }

  async lookupTransferCommandCounterByParty(
    party: Party,
  ): Promise<LookupTransferCommandCounterByPartyResponse> {
    return this.request<LookupTransferCommandCounterByPartyResponse>(
      `/v0/transfer-command-counter/${encodeURIComponent(party)}`,
      "GET",
    );
  }

  async lookupTransferCommandStatus(
    params: LookupTransferCommandStatusParams,
  ): Promise<LookupTransferCommandStatusResponse> {
    return this.request<LookupTransferCommandStatusResponse>(
      "/v0/transfer-command/status",
      "GET",
      { query: params as Record<string, unknown> },
    );
  }

  // ─── Governance ───────────────────────────────────────────────────

  async listDsoRulesVoteRequests(): Promise<ListDsoRulesVoteRequestsResponse> {
    return this.request<ListDsoRulesVoteRequestsResponse>(
      "/v0/admin/sv/voterequests",
      "GET",
    );
  }

  async listVoteRequestResults(
    body: ListVoteRequestResultsRequest,
  ): Promise<ListVoteRequestResultsResponse> {
    return this.request<ListVoteRequestResultsResponse>(
      "/v0/admin/sv/voteresults",
      "POST",
      { body },
    );
  }

  async listAmuletPriceVotes(): Promise<ListAmuletPriceVotesResponse> {
    return this.request<ListAmuletPriceVotesResponse>(
      "/v0/amulet-price/votes",
      "GET",
    );
  }

  // ─── Migrations ───────────────────────────────────────────────────

  async getMigrationSchedule(): Promise<MigrationScheduleResponse | null> {
    try {
      return await this.request<MigrationScheduleResponse>(
        "/v0/migrations/schedule",
        "GET",
      );
    } catch (error) {
      // 404 means no migration scheduled — return null instead of throwing
      if (error instanceof Error && error.message.includes("404")) {
        return null;
      }
      throw error;
    }
  }

  async getMigrationInfo(body: GetMigrationInfoRequest): Promise<GetMigrationInfoResponse> {
    return this.request<GetMigrationInfoResponse>(
      "/v0/backfilling/migration-info",
      "POST",
      { body },
    );
  }

  // ─── Infrastructure ───────────────────────────────────────────────

  async listSvBftSequencers(): Promise<ListSvBftSequencersResponse> {
    return this.request<ListSvBftSequencersResponse>(
      "/v0/sv-bft-sequencers",
      "GET",
    );
  }

  async getMemberTrafficStatus(
    domainId: string,
    memberId: string,
  ): Promise<GetMemberTrafficStatusResponse> {
    return this.request<GetMemberTrafficStatusResponse>(
      `/v0/domains/${encodeURIComponent(domainId)}/members/${encodeURIComponent(memberId)}/traffic-status`,
      "GET",
    );
  }

  async getBackfillingStatus(): Promise<GetBackfillingStatusResponse> {
    return this.request<GetBackfillingStatusResponse>(
      "/v0/backfilling/status",
      "GET",
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
