import {
  disclosedContractFromWire,
  type DisclosedContract,
} from "@c7-digital/ledger/lite";
import type { ContractWithState, MaybeCachedContractWithState } from "./types.js";

/**
 * Bridge a scan {@link ContractWithState} (or {@link MaybeCachedContractWithState})
 * into a Ledger-API `DisclosedContract` for `submitWithDisclosures`. Scan is the
 * natural source of DSO-owned disclosures — AmuletRules, OpenMiningRound,
 * ExternalPartyAmuletRules — that a submitter can't see in its own ACS.
 *
 * The synchronizer is read from the contract's own `domain_id`: Canton's
 * "domain" is the Ledger API's "synchronizer" (same id, renamed) — Splice's own
 * frontend maps `domain_id` straight onto a disclosure's `synchronizerId`.
 *
 * Fails fast if `domain_id` is absent: a contract with no current synchronizer
 * is unassigned (e.g. mid-reassignment), so it can't take part in a command
 * submission on any synchronizer — there is nothing meaningful to disclose.
 */
export function disclosedContractFromScan(
  c: ContractWithState<unknown> | MaybeCachedContractWithState<unknown>,
): DisclosedContract {
  if (!c.contract) {
    throw new Error(
      "disclosedContractFromScan: scan response carries no contract (cached/absent)",
    );
  }
  if (!c.domain_id) {
    throw new Error(
      `disclosedContractFromScan: contract ${c.contract.contract_id} has no domain_id — ` +
        "it is unassigned (no current synchronizer) and cannot be used in a command submission",
    );
  }
  return disclosedContractFromWire({
    contractId: c.contract.contract_id,
    createdEventBlob: c.contract.created_event_blob,
    templateId: c.contract.template_id,
    synchronizerId: c.domain_id,
  });
}
