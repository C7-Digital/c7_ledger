/**
 * Typed payload overrides for Scan API responses.
 *
 * The OpenAPI spec defines contract payloads as `type: object` (no properties),
 * which openapi-typescript generates as `Record<string, never>`. These types
 * replace those empty payloads with the actual Daml template types generated
 * from Splice DAR files via @c7-digital/splice-codegen.
 */
import type { Party } from "@daml/types";
import type {
  Amulet,
  AmuletRules,
  Ans,
  DsoRules,
  ExternalPartyAmuletRules,
  Round,
  SvState,
  ValidatorLicense,
} from "@c7-digital/splice-codegen";

// ─── Re-export Daml template payload types for convenience ──────────────

export type {
  Amulet,
  AmuletRules,
  Ans,
  DsoRules,
  ExternalPartyAmuletRules,
  Round,
  SvState,
  ValidatorLicense,
} from "@c7-digital/splice-codegen";

// ─── Contract wrappers ──────────────────────────────────────────────────

/** A contract whose payload is typed to a specific Daml template. */
export interface Contract<TPayload> {
  template_id: string;
  contract_id: string;
  payload: TPayload;
  created_event_blob: string;
  created_at: string;
}

/** A ContractWithState whose contract payload is typed. */
export interface ContractWithState<TPayload> {
  contract: Contract<TPayload>;
  domain_id?: string;
}

/** A MaybeCachedContractWithState — contract may be absent if cached. */
export interface MaybeCachedContractWithState<TPayload> {
  contract?: Contract<TPayload>;
  domain_id?: string;
}

// ─── getDsoInfo ─────────────────────────────────────────────────────────

/**
 * The DSO information (`/v1/dso`). It is the same on every Scan instance, so
 * a caller can compare the answers of several Scans.
 */
export interface GetDsoInfoV1Response {
  dso_party_id: Party;
  voting_threshold: number;
  latest_mining_round: ContractWithState<Round.OpenMiningRound>;
  amulet_rules: ContractWithState<AmuletRules.AmuletRules>;
  dso_rules: ContractWithState<DsoRules.DsoRules>;
  sv_node_states: ContractWithState<SvState.SvNodeState>[];
  initial_round?: string;
}

/** The SV that operates one Scan instance (`/v0/sv-info`). */
export interface GetSvInfoResponse {
  sv_user: string;
  sv_party_id: Party;
}

/**
 * The deprecated `/v0/dso` answer: the DSO information together with the SV
 * that operates the Scan instance.
 */
export interface GetDsoInfoResponse extends GetDsoInfoV1Response, GetSvInfoResponse {}

// ─── listValidatorLicenses ──────────────────────────────────────────────

export interface ListValidatorLicensesResponse {
  validator_licenses: Contract<ValidatorLicense.ValidatorLicense>[];
  next_page_token?: number;
}

// ─── getClosedRounds ────────────────────────────────────────────────────

export interface GetClosedRoundsResponse {
  rounds: Contract<Round.ClosedMiningRound>[];
}

// ─── getOpenAndIssuingMiningRounds ──────────────────────────────────────

export interface GetOpenAndIssuingMiningRoundsResponse {
  time_to_live_in_microseconds: number;
  open_mining_rounds: Record<string, MaybeCachedContractWithState<Round.OpenMiningRound>>;
  issuing_mining_rounds: Record<string, MaybeCachedContractWithState<Round.IssuingMiningRound>>;
}

// ─── getAmuletRules ─────────────────────────────────────────────────────

export interface GetAmuletRulesResponse {
  amulet_rules_update: MaybeCachedContractWithState<AmuletRules.AmuletRules>;
}

// ─── getExternalPartyAmuletRules ────────────────────────────────────────

export interface GetExternalPartyAmuletRulesResponse {
  external_party_amulet_rules_update: MaybeCachedContractWithState<ExternalPartyAmuletRules.ExternalPartyAmuletRules>;
}

// ─── getAnsRules ────────────────────────────────────────────────────────

export interface GetAnsRulesResponse {
  ans_rules_update: MaybeCachedContractWithState<Ans.AnsRules>;
}

// ─── listFeaturedAppRights ──────────────────────────────────────────────

export interface ListFeaturedAppRightsResponse {
  featured_apps: Contract<Amulet.FeaturedAppRight>[];
}

export interface LookupFeaturedAppRightResponse {
  featured_app_right?: Contract<Amulet.FeaturedAppRight>;
}

// ─── lookupTransferPreapproval ──────────────────────────────────────────

export interface LookupTransferPreapprovalByPartyResponse {
  transfer_preapproval: ContractWithState<AmuletRules.TransferPreapproval>;
}

// ─── lookupTransferCommandCounter ───────────────────────────────────────

export interface LookupTransferCommandCounterByPartyResponse {
  transfer_command_counter: ContractWithState<ExternalPartyAmuletRules.TransferCommandCounter>;
}

// ─── lookupTransferCommandStatus ────────────────────────────────────────

export interface TransferCommandContractWithStatus {
  contract: Contract<ExternalPartyAmuletRules.TransferCommand>;
  status: Record<string, unknown>;
}

export interface LookupTransferCommandStatusResponse {
  transfer_commands_by_contract_id: Record<string, TransferCommandContractWithStatus>;
}

// ─── listUnclaimedDevelopmentFundCoupons ─────────────────────────────────

export interface ListUnclaimedDevelopmentFundCouponsResponse {
  "unclaimed-development-fund-coupons": ContractWithState<Amulet.UnclaimedDevelopmentFundCoupon>[];
}

// ─── vote requests ──────────────────────────────────────────────────────

export interface ListDsoRulesVoteRequestsResponse {
  vote_requests: Contract<DsoRules.VoteRequest>[];
}
