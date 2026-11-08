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
import {
  ScanApiError,
  ScanProxyAuthError,
  ScanUnavailableError,
  type ScanAttempt,
  attemptOf,
  describeError,
  readErrorBody,
} from "./error.js";

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
type GetDsoInfoV1Response = Typed.GetDsoInfoV1Response;
type GetSvInfoResponse = Typed.GetSvInfoResponse;

type GetDsoPartyIdOperation = operations["getDsoPartyId"];
type GetDsoPartyIdResponse = {
  dso_party_id: Party;
};

type GetMigrationIdResponse = {
  migration_id: number;
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

type GetAcsSnapshotOperation = operations["getAcsSnapshotAtV2"];
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

type GetHoldingsStateOperation = operations["getHoldingsStateAtV2"];
type GetHoldingsStateRequest =
  GetHoldingsStateOperation["requestBody"]["content"]["application/json"];
type GetHoldingsStateResponse =
  GetHoldingsStateOperation["responses"]["200"]["content"]["application/json"];

type GetHoldingsSummaryOperation = operations["getHoldingsSummaryAtV1"];
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
type GetOpenAndIssuingMiningRoundsProxyResponse = Typed.GetOpenAndIssuingMiningRoundsProxyResponse;

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
type GetAmuletRulesProxyResponse = Typed.GetAmuletRulesProxyResponse;

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

// ─── Transfers ─────────────────────────────────────────────────────────

type LookupTransferPreapprovalByPartyResponse = Typed.LookupTransferPreapprovalByPartyResponse;
type LookupTransferCommandCounterByPartyResponse = Typed.LookupTransferCommandCounterByPartyResponse;

type LookupTransferCommandStatusOperation = operations["lookupTransferCommandStatus"];
type LookupTransferCommandStatusParams =
  LookupTransferCommandStatusOperation["parameters"]["query"];
type LookupTransferCommandStatusResponse = Typed.LookupTransferCommandStatusResponse;

// ─── Governance ────────────────────────────────────────────────────────

type ListDsoRulesVoteRequestsOperation = operations["listDsoRulesVoteRequests"];
type ListDsoRulesVoteRequestsResponse =
  ListDsoRulesVoteRequestsOperation["responses"]["200"]["content"]["application/json"];

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

type GetUpdatesBeforeOperation = operations["getUpdatesBefore"];
type GetUpdatesBeforeRequest =
  GetUpdatesBeforeOperation["requestBody"]["content"]["application/json"];
type GetUpdatesBeforeResponse =
  GetUpdatesBeforeOperation["responses"]["200"]["content"]["application/json"];

type GetImportUpdatesOperation = operations["getImportUpdates"];
type GetImportUpdatesRequest =
  GetImportUpdatesOperation["requestBody"]["content"]["application/json"];
type GetImportUpdatesResponse =
  GetImportUpdatesOperation["responses"]["200"]["content"]["application/json"];

// ─── Governance (lookups) ──────────────────────────────────────────────

type ListVoteRequestsByTrackingCidOperation = operations["listVoteRequestsByTrackingCid"];
type ListVoteRequestsByTrackingCidRequest =
  ListVoteRequestsByTrackingCidOperation["requestBody"]["content"]["application/json"];
type ListVoteRequestsByTrackingCidResponse =
  ListVoteRequestsByTrackingCidOperation["responses"]["200"]["content"]["application/json"];

type LookupDsoRulesVoteRequestOperation = operations["lookupDsoRulesVoteRequest"];
type LookupDsoRulesVoteRequestResponse =
  LookupDsoRulesVoteRequestOperation["responses"]["200"]["content"]["application/json"];

// ─── Misc ──────────────────────────────────────────────────────────────

type ListUnclaimedDevelopmentFundCouponsResponse = Typed.ListUnclaimedDevelopmentFundCouponsResponse;

type GetHealthStatusOperation = operations["getHealthStatus"];
type GetHealthStatusResponse =
  GetHealthStatusOperation["responses"]["200"]["content"]["application/json"];

type GetVersionOperation = operations["getVersion"];
type GetVersionResponse =
  GetVersionOperation["responses"]["200"]["content"]["application/json"];

// ─── Client Config ─────────────────────────────────────────────────────

/**
 * The access token for one request to the validator's scan proxy. The client
 * calls it for each request, so a refreshed token applies, and it never keeps
 * a token. `undefined` (for example, nobody is signed in) reads from the Scans.
 */
export type ScanProxyToken = () => string | undefined | Promise<string | undefined>;

/**
 * The validator's scan proxy (`/v0/scan-proxy/*` of the validator API). The
 * validator reads Scan with Splice's BFT Scan connection: it asks several Scans
 * and needs f+1 equal answers. The proxy needs a JWT that the validator
 * accepts (its issuer and audience), and no user rights.
 */
export interface ValidatorScanProxyConfig {
  /**
   * Base URL of the validator API that `/v0/scan-proxy/...` follows, e.g.
   * "https://validator.example.com/api/validator", or a same-origin proxy path
   * such as "/api/validator".
   */
  baseUrl: string;
  token: ScanProxyToken;
}

/** Where one read came from. */
export type ScanReadSource = "proxy" | "scan";

/** One read that a source answered (see {@link ScanClientOptions.onRead}). */
export interface ScanRead {
  /** The path of the read on that source, without the query. */
  path: string;
  source: ScanReadSource;
  baseUrl: string;
}

interface ScanClientOptions {
  /** Enable verbose request/response logging via the logger */
  debug?: boolean;
  /**
   * Abort a request to one Scan, or to the scan proxy, after this many
   * milliseconds. The client then tries the next source. Default: no limit
   * for one Scan without a proxy, {@link DEFAULT_LIST_TIMEOUT_MS} otherwise.
   */
  timeoutMs?: number;
  /**
   * After a Scan of a list, or the scan proxy, is unavailable, the client
   * tries the other sources first for this many milliseconds. Default
   * {@link DEFAULT_COOLDOWN_MS}.
   */
  cooldownMs?: number;
  /**
   * Optional. The reads that the validator's scan proxy serves go to it
   * first (see {@link PROXY_PATHS}). Without it, every read goes to the Scans.
   */
  validator?: ValidatorScanProxyConfig;
  /**
   * Called after each read with the source that answered, so that an app can
   * see which reads came through the BFT proxy. An error that it throws is
   * logged and does not change the read.
   */
  onRead?: (read: ScanRead) => void;
}

/** One Scan. Its errors reach the caller as they are. */
export interface SingleScanConfig extends ScanClientOptions {
  /** Base URL of the Scan API, e.g. "https://scan.example.com/api/scan" */
  baseUrl: string;
  baseUrls?: never;
}

/** Base URLs of the Scan API of one network, the preferred Scan first. */
export type ScanBaseUrls = readonly [string, ...string[]];

/**
 * An ordered list of Scans of one network. Each Super Validator runs a Scan, and
 * each Scan serves the same network state. The client sends each request to the
 * first Scan that is not cooling down. When that Scan is unavailable (see
 * {@link isScanUnavailable}), the client tries the next Scan.
 */
export interface ScanListConfig extends ScanClientOptions {
  baseUrls: ScanBaseUrls;
  baseUrl?: never;
}

export type ScanClientConfig = SingleScanConfig | ScanListConfig;

/** The default per-Scan request limit of a list of Scans. */
export const DEFAULT_LIST_TIMEOUT_MS = 15_000;

/** The default time that a list client tries the other Scans first. */
export const DEFAULT_COOLDOWN_MS = 30_000;

/**
 * The HTTP status of a {@link ScanApiError}-shaped value (a numeric `status`
 * and a string `statusText`), read structurally and not with `instanceof`, so
 * that an error from another installed copy of this package is read the same
 * way. The same rule as `httpStatusOf` of `@c7-digital/ledger`.
 */
function scanStatusOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const { status, statusText } = error as { status?: unknown; statusText?: unknown };
  return typeof status === "number" && typeof statusText === "string" ? status : undefined;
}

/** A Scan that does not have the endpoint answers 404. */
function isNotFound(error: unknown): boolean {
  return scanStatusOf(error) === 404;
}

/** The largest delay that a timer (and so `AbortSignal.timeout`) can hold. */
const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * The HTTP statuses that tell that this Scan cannot answer now, not that the
 * request is wrong. 401 and 403 come from an IP allowlist or a gateway in front
 * of a Scan (Scan itself has no authentication), 408 and 429 from load, and 5xx
 * from the Scan or its proxy. Every other status is the network's answer, and
 * another Scan gives the same answer.
 */
const UNAVAILABLE_STATUSES: ReadonlySet<number> = new Set([401, 403, 408, 429]);

/**
 * Whether `error` (from one Scan) means that this Scan is unavailable, so that
 * another Scan can answer. A failed `fetch` (network, CORS, timeout) is also
 * unavailable.
 */
export function isScanUnavailable(error: unknown): boolean {
  // A refused proxy token is a configuration error, not an outage.
  if ((error as { name?: unknown } | null)?.name === "ScanProxyAuthError") return false;
  const status = scanStatusOf(error);
  if (status !== undefined) {
    return status >= 500 || UNAVAILABLE_STATUSES.has(status);
  }
  return true;
}

/**
 * The endpoints (base URL + path) that answered 404 in this process. A later
 * request to one of them goes to its fallback directly, so each new client
 * does not pay a 404 again. An upgraded Scan still serves the deprecated
 * fallback endpoints, so the record stays correct for the process.
 */
const missingEndpoints = new Set<string>();

/**
 * For each Scan base URL, the time (`Date.now()`) until which list clients try
 * the other Scans first. It is shared in the process, because an app often makes
 * a new client for each action, and each one must not pay for a refusing Scan
 * again.
 */
const coolingUntil = new Map<string, number>();

/**
 * The order in which to try `scans` now: the Scans that are not cooling down,
 * in their given order, then the cooling Scans, the earliest to recover first.
 * A cooling Scan stays in the order, so a request still has a chance when every
 * Scan is cooling.
 */
function tryOrder(scans: readonly string[], now: number): string[] {
  const ready = scans.filter(s => (coolingUntil.get(s) ?? 0) <= now);
  const cooling = scans
    .filter(s => (coolingUntil.get(s) ?? 0) > now)
    .sort((a, b) => coolingUntil.get(a)! - coolingUntil.get(b)!);
  return [...ready, ...cooling];
}

/**
 * The scan-proxy path (on the validator API) of each read that the proxy
 * serves. The proxy reads Scan with BFT consensus. A read that is not here
 * goes to the Scans. Each path is in the validator's `scan-proxy.yaml`
 * (see `client.paths.test.ts`).
 */
export const PROXY_PATHS = {
  getDsoPartyId: "/v0/scan-proxy/dso-party-id",
  getDsoInfoV1: "/v1/scan-proxy/dso",
  lookupFeaturedAppRight: "/v0/scan-proxy/featured-apps/{provider_party_id}",
  getCurrentMiningRounds: "/v0/scan-proxy/open-and-issuing-mining-rounds",
  getCurrentAmuletRules: "/v0/scan-proxy/amulet-rules",
  lookupAnsEntryByParty: "/v0/scan-proxy/ans-entries/by-party/{party}",
  listAnsEntries: "/v0/scan-proxy/ans-entries",
  lookupAnsEntryByName: "/v0/scan-proxy/ans-entries/by-name/{name}",
  getAnsRules: "/v0/scan-proxy/ans-rules",
  lookupTransferPreapprovalByParty: "/v0/scan-proxy/transfer-preapprovals/by-party/{party}",
  lookupTransferCommandCounterByParty: "/v0/scan-proxy/transfer-command-counter/{party}",
  lookupTransferCommandStatus: "/v0/scan-proxy/transfer-command/status",
  getHoldingsSummary: "/v1/scan-proxy/holdings/summary",
  getUnclaimedDevelopmentFundCoupons: "/v0/scan-proxy/unclaimed-development-fund-coupons",
} as const;

/** The reads that the validator's scan proxy serves. */
export type ProxiedRead = keyof typeof PROXY_PATHS;

/** `template` of {@link PROXY_PATHS} with each `{name}` replaced by its encoded value. */
function proxyPath(template: string, params: Record<string, string> = {}): string {
  return template.replace(/\{([a-z_]+)\}/g, (_, name: string) => encodeURIComponent(params[name] ?? ""));
}

/** One request to the validator's scan proxy, and how to read its answer. */
interface ProxyRequest<T> {
  path: string;
  method: "GET" | "POST";
  body?: unknown;
  query?: Record<string, unknown>;
  /**
   * What a 404 from the proxy means. `answer`: the network has no such
   * entry, as on Scan. `missing`: this validator does not serve the path (an
   * older Splice line), so the read goes to the Scans.
   */
  notFound: "answer" | "missing";
  /** The proxy's answer in the shape that the method returns. */
  decode: (raw: unknown) => T;
}

/**
 * How the client serves one read. `scans`: the Scans of the config (failover
 * across a list). `proxy`: the validator's scan proxy first; when it is
 * unavailable, the Scans.
 */
type ReadRoute<T> =
  | { kind: "scans"; path: string; fromScans: () => Promise<T> }
  | {
      kind: "proxy";
      validator: ValidatorScanProxyConfig;
      request: ProxyRequest<T>;
      fromScans: () => Promise<T>;
    };

/** The same shape on the proxy and on Scan. */
const sameShape = <T>(raw: unknown): T => raw as T;

/** The full contracts of a Scan cache answer (a request without cached ids). */
function contractsOf<TPayload>(
  byId: Record<string, Typed.MaybeCachedContractWithState<TPayload>>,
): Typed.ContractWithState<TPayload>[] {
  return Object.values(byId).flatMap(c =>
    c.contract === undefined ? [] : [{ contract: c.contract, domain_id: c.domain_id }],
  );
}

// ─── ScanClient ────────────────────────────────────────────────────────

// The Scan API is spec'd as public — its content (DSO party, mining
// rounds, amulet rules) is Canton Network state anyone should be able
// to read, and the reference OpenAPI schema declares no `security:`
// requirement. Deployments that gate Scan behind a corporate reverse
// proxy do so at the network layer (VPN, mTLS, nginx-basic-auth); this
// client doesn't participate in that. Many SV Scans allow only the IPs of
// known validators, and refuse other callers with 403: a list of Scans
// ({@link ScanListConfig}) keeps the client working when one Scan refuses.
export class ScanClient {
  /** The Scans, the preferred Scan first. */
  public readonly baseUrls: ScanBaseUrls;
  public debug: boolean;
  /** The validator's scan proxy, when the config has one. */
  public readonly validator: ValidatorScanProxyConfig | undefined;
  private readonly isList: boolean;
  private readonly timeoutMs: number | undefined;
  private readonly cooldownMs: number;
  private readonly onRead: ((read: ScanRead) => void) | undefined;

  constructor(config: ScanClientConfig) {
    this.validator = config.validator;
    this.onRead = config.onRead;
    const timeoutDefault = config.validator === undefined ? undefined : DEFAULT_LIST_TIMEOUT_MS;
    if (config.baseUrls !== undefined) {
      const unique = [...new Set(config.baseUrls)];
      if (unique.length === 0) {
        throw new RangeError("ScanClient: baseUrls must name at least one Scan");
      }
      this.baseUrls = [unique[0]!, ...unique.slice(1)];
      this.isList = true;
      this.timeoutMs = config.timeoutMs ?? DEFAULT_LIST_TIMEOUT_MS;
    } else {
      this.baseUrls = [config.baseUrl];
      this.isList = false;
      this.timeoutMs = config.timeoutMs ?? timeoutDefault;
    }
    this.cooldownMs = config.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    if (
      this.timeoutMs !== undefined &&
      !(Number.isInteger(this.timeoutMs) && this.timeoutMs >= 1 && this.timeoutMs <= MAX_TIMEOUT_MS)
    ) {
      throw new RangeError(
        `ScanClient: timeoutMs must be an integer from 1 to ${MAX_TIMEOUT_MS}, not ${this.timeoutMs}`,
      );
    }
    if (!(Number.isFinite(this.cooldownMs) && this.cooldownMs >= 0)) {
      throw new RangeError(`ScanClient: cooldownMs must be zero or more, not ${this.cooldownMs}`);
    }
    this.debug = config.debug ?? false;
  }

  /** The preferred Scan. */
  public get baseUrl(): string {
    return this.baseUrls[0];
  }

  private request<TResponse>(
    path: string,
    method: "GET" | "POST",
    options?: {
      body?: unknown;
      query?: Record<string, unknown>;
    },
  ): Promise<TResponse> {
    return this.onAnyScan(path, this.baseUrls, baseUrl =>
      this.requestTo<TResponse>(baseUrl, path, method, options),
    );
  }

  /** Report a read to {@link ScanClientOptions.onRead}; its errors do not reach the read. */
  private reported(read: ScanRead): void {
    if (this.onRead === undefined) return;
    try {
      this.onRead(read);
    } catch (error) {
      logger.warn(`The onRead hook threw (${describeError(error)}); the read is not changed`);
    }
  }

  /**
   * The route of a read that the scan proxy serves: the proxy, when the
   * config has one and that validator has the path; else the Scans.
   */
  private route<T>(request: ProxyRequest<NoInfer<T>>, fromScans: () => Promise<T>): ReadRoute<T> {
    const validator = this.validator;
    if (validator === undefined || missingEndpoints.has(`${validator.baseUrl}${request.path}`)) {
      return { kind: "scans", path: request.path, fromScans };
    }
    return { kind: "proxy", validator, request, fromScans };
  }

  /**
   * Serve `route`. A proxy read that the proxy cannot answer goes to the
   * Scans, and each such fallback is logged. A 401 from the proxy is a
   * configuration error ({@link ScanProxyAuthError}) and does not fall back.
   */
  private async read<T>(route: ReadRoute<T>): Promise<T> {
    switch (route.kind) {
      case "scans":
        return route.fromScans();
      case "proxy": {
        const { validator, request } = route;
        const baseUrl = validator.baseUrl;
        const token = await validator.token();
        if (token === undefined) {
          logger.debug(`No scan-proxy token; reading ${request.path} from the Scans`);
          return route.fromScans();
        }
        if ((coolingUntil.get(baseUrl) ?? 0) > Date.now()) {
          logger.warn(`Scan proxy ${baseUrl} is cooling down; reading ${request.path} from the Scans`);
          return route.fromScans();
        }
        let raw: unknown;
        try {
          raw = await this.requestTo<unknown>(baseUrl, request.path, request.method, {
            body: request.body,
            query: request.query,
            headers: { Authorization: `Bearer ${token}` },
          });
        } catch (error) {
          if (error instanceof ScanApiError && scanStatusOf(error) === 401) {
            throw new ScanProxyAuthError(baseUrl, error);
          }
          if (isNotFound(error)) {
            if (request.notFound === "answer") throw error;
            missingEndpoints.add(`${baseUrl}${request.path}`);
            logger.warn(`Scan proxy ${baseUrl} does not serve ${request.path}; reading it from the Scans`);
            return route.fromScans();
          }
          if (!isScanUnavailable(error)) throw error;
          coolingUntil.set(baseUrl, Date.now() + this.cooldownMs);
          logger.warn(
            `Scan proxy ${baseUrl} is unavailable (${describeError(error)}); reading ${request.path} from the Scans`,
          );
          try {
            return await route.fromScans();
          } catch (scansError) {
            if (scansError instanceof ScanUnavailableError) {
              throw new ScanUnavailableError([attemptOf(baseUrl, error), ...scansError.attempts]);
            }
            throw scansError;
          }
        }
        coolingUntil.delete(baseUrl);
        this.reported({ path: request.path, source: "proxy", baseUrl });
        return request.decode(raw);
      }
    }
  }

  /**
   * Call `send` on one Scan of `scans`. One Scan: its result or its error. A
   * list: the first Scan in {@link tryOrder} that is not unavailable. An
   * unavailable Scan cools down. When every Scan is unavailable, the client
   * throws {@link ScanUnavailableError}.
   */
  private async onAnyScan<TResponse>(
    path: string,
    scans: readonly string[],
    send: (baseUrl: string) => Promise<TResponse>,
  ): Promise<TResponse> {
    if (!this.isList) {
      const result = await send(scans[0]!);
      this.reported({ path, source: "scan", baseUrl: scans[0]! });
      return result;
    }
    const attempts: ScanAttempt[] = [];
    for (const baseUrl of tryOrder(scans, Date.now())) {
      try {
        const result = await send(baseUrl);
        coolingUntil.delete(baseUrl);
        this.reported({ path, source: "scan", baseUrl });
        return result;
      } catch (error) {
        if (!isScanUnavailable(error)) {
          // An answer, for example 404: the Scan is available.
          coolingUntil.delete(baseUrl);
          throw error;
        }
        attempts.push(attemptOf(baseUrl, error));
        const wasReady = (coolingUntil.get(baseUrl) ?? 0) <= Date.now();
        coolingUntil.set(baseUrl, Date.now() + this.cooldownMs);
        if (wasReady) {
          logger.warn(`Scan ${baseUrl} is unavailable (${describeError(error)}); trying the other Scans first`);
        }
      }
    }
    throw new ScanUnavailableError(attempts);
  }

  private async requestTo<TResponse>(
    baseUrl: string,
    path: string,
    method: "GET" | "POST",
    options?: {
      body?: unknown;
      query?: Record<string, unknown>;
      headers?: Record<string, string>;
    },
  ): Promise<TResponse> {
    let url = `${baseUrl}${path}`;

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
      ...options?.headers,
    };

    // `credentials: "omit"` — explicitly tell the browser NOT to attach
    // cookies for the destination origin. Default `credentials` is
    // `"same-origin"`, which silently stamps every cookie the page
    // origin holds onto the request. Some deployments sit Scan behind
    // a gateway sharing an origin with the UI that sets session-
    // affinity / sticky cookies (envoy, istio, helm ingresses); those
    // pile up and eventually overflow nginx's
    // `large_client_header_buffers`. Scan doesn't consume cookies, so
    // omitting them is unambiguously correct. See the matching change
    // in `ledger/src/client.ts`.
    const requestInit: RequestInit = { method, credentials: "omit", headers };
    if (options?.body) {
      requestInit.body = JSON.stringify(options.body);
    }
    if (this.timeoutMs !== undefined) {
      requestInit.signal = AbortSignal.timeout(this.timeoutMs);
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
      const body = await readErrorBody(response);
      if (this.debug) {
        logger.error(`[scan-debug] ← ${response.status} ${response.statusText}`, body);
      }
      throw new ScanApiError(response.status, response.statusText, body);
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
    const query = params as Record<string, unknown>;
    return this.read(
      this.route(
        { path: PROXY_PATHS.listAnsEntries, method: "GET", query, notFound: "answer", decode: sameShape },
        () => this.request<ListAnsEntriesResponse>("/v0/ans-entries", "GET", { query }),
      ),
    );
  }

  async lookupAnsEntryByParty(party: Party): Promise<LookupAnsEntryByPartyResponse> {
    return this.read(
      this.route(
        {
          path: proxyPath(PROXY_PATHS.lookupAnsEntryByParty, { party }),
          method: "GET",
          notFound: "answer",
          decode: sameShape,
        },
        () =>
          this.request<LookupAnsEntryByPartyResponse>(
            `/v0/ans-entries/by-party/${encodeURIComponent(party)}`,
            "GET",
          ),
      ),
    );
  }

  async lookupAnsEntryByName(name: string): Promise<LookupAnsEntryByNameResponse> {
    return this.read(
      this.route(
        {
          path: proxyPath(PROXY_PATHS.lookupAnsEntryByName, { name }),
          method: "GET",
          notFound: "answer",
          decode: sameShape,
        },
        () =>
          this.request<LookupAnsEntryByNameResponse>(
            `/v0/ans-entries/by-name/${encodeURIComponent(name)}`,
            "GET",
          ),
      ),
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

  /**
   * @deprecated Splice deprecates `/v0/dso`. Use {@link getDsoInfoV1}, and
   * {@link getSvInfo} for `sv_user` and `sv_party_id`.
   */
  async getDsoInfo(): Promise<GetDsoInfoResponse> {
    return this.request<GetDsoInfoResponse>("/v0/dso", "GET");
  }

  /**
   * The DSO information, without the SV that operates this Scan. Splice 0.10
   * adds `/v1/dso`. A Scan without it answers 404, and then this method reads
   * `/v0/dso` and removes the SV fields, so the answer has the same shape on
   * every Splice version. After one 404, every client of that Scan reads
   * `/v0/dso` directly.
   */
  async getDsoInfoV1(): Promise<GetDsoInfoV1Response> {
    return this.read(
      this.route(
        { path: PROXY_PATHS.getDsoInfoV1, method: "GET", notFound: "missing", decode: sameShape },
        () =>
          this.getOrFallback("/v1/dso", async () => {
            const { sv_user: _svUser, sv_party_id: _svPartyId, ...dso } = await this.getDsoInfo();
            return dso;
          }),
      ),
    );
  }

  /**
   * The SV that operates this Scan. Splice 0.10 adds `/v0/sv-info`. A Scan
   * without it answers 404, and then this method reads the SV fields of
   * `/v0/dso`.
   */
  async getSvInfo(): Promise<GetSvInfoResponse> {
    return this.getOrFallback("/v0/sv-info", async () => {
      const { sv_user, sv_party_id } = await this.getDsoInfo();
      return { sv_user, sv_party_id };
    });
  }

  /**
   * GET `path`, or call `fallback` when the Scan does not have `path`. A 404 is
   * recorded in {@link missingEndpoints} for the Scan that gave it; any other
   * error is thrown. A list client asks only the Scans that are not recorded.
   */
  private async getOrFallback<TResponse>(
    path: string,
    fallback: () => Promise<TResponse>,
  ): Promise<TResponse> {
    const scans = this.baseUrls.filter(baseUrl => !missingEndpoints.has(`${baseUrl}${path}`));
    if (scans.length === 0) return fallback();
    const excluded = scans.length < this.baseUrls.length;
    try {
      return await this.onAnyScan(path, scans, async baseUrl => {
        try {
          return await this.requestTo<TResponse>(baseUrl, path, "GET");
        } catch (error) {
          if (isNotFound(error)) missingEndpoints.add(`${baseUrl}${path}`);
          throw error;
        }
      });
    } catch (error) {
      // The Scans that answered 404 still serve the fallback endpoint.
      if (isNotFound(error) || (excluded && error instanceof ScanUnavailableError)) return fallback();
      throw error;
    }
  }

  async getDsoPartyId(): Promise<GetDsoPartyIdResponse> {
    return this.read(
      this.route(
        { path: PROXY_PATHS.getDsoPartyId, method: "GET", notFound: "answer", decode: sameShape },
        () => this.request<GetDsoPartyIdResponse>("/v0/dso-party-id", "GET"),
      ),
    );
  }

  /**
   * The migration id of the synchronizer that this Scan serves now. Use it
   * for each request that takes a `migration_id`. Do not get it from
   * {@link getDsoSequencers}: a sequencer of a logical synchronizer upgrade
   * has a `synchronizerSerial`, and its `migrationId` is -1.
   */
  async getMigrationId(): Promise<GetMigrationIdResponse> {
    return this.request<GetMigrationIdResponse>("/v0/migrations/last", "GET");
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
    return this.request<GetAcsSnapshotResponse>("/v2/state/acs", "POST", { body });
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
    return this.request<GetHoldingsStateResponse>("/v2/holdings/state", "POST", { body });
  }

  async getHoldingsSummary(body: GetHoldingsSummaryRequest): Promise<GetHoldingsSummaryResponse> {
    return this.read(
      this.route(
        { path: PROXY_PATHS.getHoldingsSummary, method: "POST", body, notFound: "answer", decode: sameShape },
        () => this.request<GetHoldingsSummaryResponse>("/v1/holdings/summary", "POST", { body }),
      ),
    );
  }

  // ─── Rounds ────────────────────────────────────────────────────────

  async getClosedRounds(): Promise<GetClosedRoundsResponse> {
    return this.request<GetClosedRoundsResponse>("/v0/closed-rounds", "GET");
  }

  /**
   * The open and issuing mining rounds, as full contracts. Through the
   * validator's scan proxy when the config has one (BFT); else from the Scans,
   * with an empty cache. {@link getOpenAndIssuingMiningRounds} is Scan's own
   * endpoint, with its cache protocol, and always reads the Scans.
   */
  async getCurrentMiningRounds(): Promise<GetOpenAndIssuingMiningRoundsProxyResponse> {
    return this.read(
      this.route(
        { path: PROXY_PATHS.getCurrentMiningRounds, method: "GET", notFound: "answer", decode: sameShape },
        async () => {
          const rounds = await this.getOpenAndIssuingMiningRounds({
            cached_open_mining_round_contract_ids: [],
            cached_issuing_round_contract_ids: [],
          });
          return {
            open_mining_rounds: contractsOf(rounds.open_mining_rounds),
            issuing_mining_rounds: contractsOf(rounds.issuing_mining_rounds),
          };
        },
      ),
    );
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

  /**
   * The AmuletRules contract. Through the validator's scan proxy when the
   * config has one (BFT); else from the Scans, with an empty cache.
   * {@link getAmuletRules} is Scan's own endpoint, with its cache protocol,
   * and always reads the Scans.
   */
  async getCurrentAmuletRules(): Promise<GetAmuletRulesProxyResponse> {
    return this.read(
      this.route(
        { path: PROXY_PATHS.getCurrentAmuletRules, method: "GET", notFound: "answer", decode: sameShape },
        async () => {
          const { amulet_rules_update: update } = await this.getAmuletRules();
          if (update.contract === undefined) {
            throw new Error("Scan sent no AmuletRules contract for a request without a cached contract");
          }
          return { amulet_rules: { contract: update.contract, domain_id: update.domain_id } };
        },
      ),
    );
  }

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
    const request = body ?? {};
    return this.read(
      this.route(
        { path: PROXY_PATHS.getAnsRules, method: "POST", body: request, notFound: "answer", decode: sameShape },
        () => this.request<GetAnsRulesResponse>("/v0/ans-rules", "POST", { body: request }),
      ),
    );
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
    return this.read(
      this.route(
        {
          path: proxyPath(PROXY_PATHS.lookupFeaturedAppRight, { provider_party_id: providerPartyId }),
          method: "GET",
          notFound: "answer",
          decode: sameShape,
        },
        () =>
          this.request<LookupFeaturedAppRightResponse>(
            `/v0/featured-apps/${encodeURIComponent(providerPartyId)}`,
            "GET",
          ),
      ),
    );
  }

  // ─── Transfers ────────────────────────────────────────────────────

  async lookupTransferPreapprovalByParty(
    party: Party,
  ): Promise<LookupTransferPreapprovalByPartyResponse> {
    return this.read(
      this.route(
        {
          path: proxyPath(PROXY_PATHS.lookupTransferPreapprovalByParty, { party }),
          method: "GET",
          notFound: "answer",
          decode: sameShape,
        },
        () =>
          this.request<LookupTransferPreapprovalByPartyResponse>(
            `/v0/transfer-preapprovals/by-party/${encodeURIComponent(party)}`,
            "GET",
          ),
      ),
    );
  }

  async lookupTransferCommandCounterByParty(
    party: Party,
  ): Promise<LookupTransferCommandCounterByPartyResponse> {
    return this.read(
      this.route(
        {
          path: proxyPath(PROXY_PATHS.lookupTransferCommandCounterByParty, { party }),
          method: "GET",
          notFound: "answer",
          decode: sameShape,
        },
        () =>
          this.request<LookupTransferCommandCounterByPartyResponse>(
            `/v0/transfer-command-counter/${encodeURIComponent(party)}`,
            "GET",
          ),
      ),
    );
  }

  async lookupTransferCommandStatus(
    params: LookupTransferCommandStatusParams,
  ): Promise<LookupTransferCommandStatusResponse> {
    const query = params as Record<string, unknown>;
    return this.read(
      this.route(
        {
          path: PROXY_PATHS.lookupTransferCommandStatus,
          method: "GET",
          query,
          notFound: "answer",
          decode: sameShape,
        },
        () =>
          this.request<LookupTransferCommandStatusResponse>("/v0/transfer-command/status", "GET", {
            query,
          }),
      ),
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
      if (error instanceof Error && error.message.startsWith("HTTP 404")) {
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

  async getUpdatesBefore(body: GetUpdatesBeforeRequest): Promise<GetUpdatesBeforeResponse> {
    return this.request<GetUpdatesBeforeResponse>(
      "/v0/backfilling/updates-before",
      "POST",
      { body },
    );
  }

  async getImportUpdates(body: GetImportUpdatesRequest): Promise<GetImportUpdatesResponse> {
    return this.request<GetImportUpdatesResponse>(
      "/v0/backfilling/import-updates",
      "POST",
      { body },
    );
  }

  // ─── Governance (lookups) ─────────────────────────────────────────

  /**
   * Look up VoteRequests by their contract IDs.
   * Method name matches the Scan API operationId; the request body takes `vote_request_contract_ids`.
   */
  async listVoteRequestsByTrackingCid(
    body: ListVoteRequestsByTrackingCidRequest,
  ): Promise<ListVoteRequestsByTrackingCidResponse> {
    return this.request<ListVoteRequestsByTrackingCidResponse>(
      "/v0/voterequest",
      "POST",
      { body },
    );
  }

  async lookupDsoRulesVoteRequest(
    voteRequestContractId: string,
  ): Promise<LookupDsoRulesVoteRequestResponse> {
    return this.request<LookupDsoRulesVoteRequestResponse>(
      `/v0/voterequests/${encodeURIComponent(voteRequestContractId)}`,
      "GET",
    );
  }

  // ─── Misc ──────────────────────────────────────────────────────────

  async getUnclaimedDevelopmentFundCoupons(): Promise<ListUnclaimedDevelopmentFundCouponsResponse> {
    return this.read(
      this.route(
        {
          path: PROXY_PATHS.getUnclaimedDevelopmentFundCoupons,
          method: "GET",
          notFound: "answer",
          decode: sameShape,
        },
        () =>
          this.request<ListUnclaimedDevelopmentFundCouponsResponse>(
            "/v0/unclaimed-development-fund-coupons",
            "GET",
          ),
      ),
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
