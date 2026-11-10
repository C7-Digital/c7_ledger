export {
  ScanApiError,
  ScanUnavailableError,
  ScanProxyAuthError,
  type ScanAttempt,
  type ScanErrorBody,
} from "./error.js";
export {
  ScanClient,
  DEFAULT_COOLDOWN_MS,
  DEFAULT_LIST_TIMEOUT_MS,
  isScanUnavailable,
  PROXY_PATHS,
  type ProxiedRead,
  type ScanProxyToken,
  type ValidatorScanProxyConfig,
  type ScanRead,
  type ScanReadSource,
  type ScanClientConfig,
  type SingleScanConfig,
  type ScanListConfig,
  type ScanBaseUrls,
  type AnsEntry,
} from "./client.js";
export { disclosedContractFromScan } from "./disclosure.js";
export { type Logger, ConsoleLogger, NoOpLogger, logger, setLogger } from "./logger.js";
export { SPLICE_VERSION } from "./generated/sdk-version.js";
export type { paths, operations, components } from "./generated/api.js";
export type {
  // Splice template namespaces (re-exported from @c7-digital/splice-codegen)
  Amulet,
  AmuletRules,
  Ans,
  DsoRules,
  ExternalPartyAmuletRules,
  Round,
  SvState,
  ValidatorLicense,
  // Contract wrappers
  Contract,
  ContractWithState,
  MaybeCachedContractWithState,
  // Typed Scan API responses
  GetDsoInfoResponse,
  GetDsoInfoV1Response,
  GetSvInfoResponse,
  ListValidatorLicensesResponse,
  GetClosedRoundsResponse,
  GetOpenAndIssuingMiningRoundsResponse,
  GetAmuletRulesResponse,
  GetAmuletRulesProxyResponse,
  GetOpenAndIssuingMiningRoundsProxyResponse,
  GetExternalPartyAmuletRulesResponse,
  GetAnsRulesResponse,
  ListFeaturedAppRightsResponse,
  LookupFeaturedAppRightResponse,
  LookupTransferPreapprovalByPartyResponse,
  LookupTransferCommandCounterByPartyResponse,
  TransferCommandContractWithStatus,
  LookupTransferCommandStatusResponse,
  ListUnclaimedDevelopmentFundCouponsResponse,
  ListDsoRulesVoteRequestsResponse,
  // updateHistory (POST /v2/updates)
  GetUpdatesV2Request,
  GetUpdatesV2Response,
  UpdateHistoryItemV2,
  UpdateHistoryTransactionV2,
  UpdateHistoryReassignment,
} from "./types.js";
