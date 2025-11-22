import { ContractId, Party } from "@daml/types";
import {
  type Ledger,
  type User,
  type CreateEvent,
  LedgerOffset,
  type MultiStream,
  type TemplateMapping,
  CantonError,
} from "@c7/ledger/lite";

// Brand template ID strings for type safety
export type TemplateId = string & { readonly __templateId: unique symbol };

export interface DamlLedgerConfig {
  readonly ledger: Ledger;
  readonly reloadTrigger: number;
  readonly triggerReload: () => void;
}

export interface QueryOptions {
  /** The offset to query at, defaults to "end" */
  readonly atOffset?: LedgerOffset;
  /** Whether to include the created event blob, defaults to false */
  readonly includeCreatedEventBlob?: boolean;
  /** Whether to query as a specific party, defaults to all of the Parties in the token. */
  readonly readAsParties?: Party[];
  /** Whether to automatically reload on updates, defaults to false */
  readonly autoReload?: boolean;
}

export interface QueryResult<TContract extends object = object, TKey = any> {
  /** Array of matching contracts */
  readonly contracts: readonly CreateEvent<TContract, TKey>[];
  /** Loading state */
  readonly loading: boolean;
  /** Error if query failed */
  readonly error: Error | null;
  /** Function to manually reload the query */
  readonly reload: () => void;
}

export interface StreamQueryResult<TContract extends object = object, TKey = any> {
  /** Map of matching contracts, with contractId as key */
  readonly contractsMap: ReadonlyMap<ContractId<TContract>, CreateEvent<TContract, TKey>>;
  /** Loading state */
  readonly loading: boolean;
  /** Error if query failed */
  readonly error: CantonError | string | null;
  /** Function to manually reload the query */
  readonly reload: () => void;
  /** Whether the stream is connected */
  readonly connected: boolean;
}

export interface UserResult {
  /** The user information from the token */
  readonly user: User | null;
  /** Loading state */
  readonly loading: boolean;
  /** Error if user fetch failed */
  readonly error: Error | null;
}

export interface MultiStreamQueryResult<TM extends TemplateMapping> {
  /** The multi-stream instance for registering template-specific handlers */
  readonly multiStream: MultiStream<TM> | null;
  /** Loading state */
  readonly loading: boolean;
  /** Error if stream setup failed */
  readonly error: CantonError | string | null;
  /** Function to manually reload the query */
  readonly reload: () => void;
  /** Whether the stream is connected */
  readonly connected: boolean;
}
