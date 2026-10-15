// Request bodies for the JSON Ledger API, shared by `Ledger` and by callers that
// send them over another transport (for example a CIP-0103 wallet's
// `ledgerApi` proxy). One builder means one wire shape to keep current.
import type { components } from "./generated/api";
import type { IdentifierString } from "./valueTypes";

type Schemas = components["schemas"];

export type IdentifierFilter = Schemas["IdentifierFilter"];
export type GetActiveContractsRequest = Schemas["GetActiveContractsRequest"];

/** Match the contracts of one template (a package-name or package-id ref). */
export function templateFilter(
  templateId: string,
  includeCreatedEventBlob: boolean = false
): IdentifierFilter {
  return {
    TemplateFilter: {
      value: {
        templateId: templateId as IdentifierString,
        includeCreatedEventBlob,
      },
    },
  };
}

/** Match the contracts that implement one interface, with the interface view. */
export function interfaceFilter(
  interfaceId: string,
  includeCreatedEventBlob: boolean = false
): IdentifierFilter {
  return {
    InterfaceFilter: {
      value: {
        interfaceId: interfaceId as IdentifierString,
        includeInterfaceView: true,
        includeCreatedEventBlob,
      },
    },
  };
}

/**
 * The body of `POST /v2/state/active-contracts`: the contracts each of
 * `parties` can read that match any of `filters`, as of `activeAtOffset`.
 *
 * The party filter goes in `eventFormat`. Canton 3.6 rejects the deprecated
 * top-level `filter` by default (`DEPRECATED_API_DISABLED`), and 3.4 and 3.5
 * accept `eventFormat` too. The top-level `verbose: false` stays because the
 * 3.4 request schema requires it; 3.6 accepts it.
 *
 * @param verbose Ask for verbose values (record field names) in the events.
 */
export function activeContractsRequest(
  parties: readonly string[],
  filters: readonly IdentifierFilter[],
  activeAtOffset: number,
  verbose: boolean = false
): GetActiveContractsRequest {
  const cumulative = filters.map((identifierFilter) => ({ identifierFilter }));
  return {
    verbose: false,
    activeAtOffset,
    eventFormat: {
      filtersByParty: Object.fromEntries(parties.map((party) => [party, { cumulative }])),
      verbose,
    },
  };
}
