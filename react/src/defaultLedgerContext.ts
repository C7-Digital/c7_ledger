/**
 * Default ledger context - provides the standard hooks implementation
 * This is the equivalent of @daml/react's default exports
 */
import { createLedgerContext } from "./context";

// Create and export the default context
export const {
  DamlLedger,
  useLedger,
  useUser,
  useReload,
  useQuery,
  useStreamQuery,
  useMultiStreamQuery,
  useRightsAs,
} = createLedgerContext();
