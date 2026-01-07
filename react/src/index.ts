/**
 * @c7/react - React hooks for Daml ledger integration
 *
 * A replacement for @daml/react that uses the Canton JSON API v2
 * with TypeScript support and modern React patterns.
 */

// Core components and context utilities
export { createLedgerContext } from "./context";
export type { DamlLedgerProps } from "./context";

// Default hooks (the main exports most users will use)
export {
  DamlLedger,
  useLedger,
  useUser,
  useReload,
  useQuery,
  useQueryInterface,
  useStreamQuery,
  useStreamQueryInterface,
  useMultiStreamQuery,
  useMultiStreamInterfaceQuery,
  useRightsAs,
} from "./defaultLedgerContext";

// Types
export type {
  DamlLedgerConfig,
  QueryOptions,
  QueryResult,
  InterfaceQueryResult,
  StreamQueryResult,
  UserResult,
  TemplateId,
} from "./types";

// Re-export commonly used types from the ledger package
export type { Ledger, User, CreateEvent, ArchiveEvent, Event, Interface } from "@c7-digital/ledger/lite";
