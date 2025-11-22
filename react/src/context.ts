/**
 * React context for Daml ledger integration
 */
import {
  createContext,
  useContext,
  ReactNode,
  createElement,
  useMemo,
  useState,
  useEffect,
  useCallback,
  useRef,
} from "react";
import type { Context, FunctionComponent } from "react";
import type { TemplateOrInterface, ContractId } from "@daml/types";
import {
  Ledger,
  type LedgerOptions,
  type CreateEvent,
  type PackageIdString,
  type Stream,
  type StreamState,
  type CantonError,
  type User,
  type MultiStream,
  type TemplateMapping,
} from "@c7/ledger/lite";
import type {
  DamlLedgerConfig,
  QueryOptions,
  QueryResult,
  StreamQueryResult,
  UserResult,
  MultiStreamQueryResult,
} from "./types";

// Utility type to convert template with literal string ID to PackageIdString for ledger compatibility
type ToLedgerTemplate<
  TContract extends object,
  TKey,
  // @ts-ignore
  TTemplateId extends string,
> = TemplateOrInterface<TContract, TKey, PackageIdString>;

const DamlLedgerContext: Context<DamlLedgerConfig | null> = createContext<DamlLedgerConfig | null>(
  null
);

export interface DamlLedgerProps extends LedgerOptions {
  children: ReactNode;
}

/**
 * Provider component that wraps your app and provides ledger access to hooks
 */
export const DamlLedger: FunctionComponent<DamlLedgerProps> = props => {
  const { children, ...otherProps } = props;

  const [reloadTrigger, setReloadTrigger] = useState(0);

  const ledger = useMemo(() => {
    return new Ledger(otherProps);
  }, [reloadTrigger, otherProps]);

  const triggerReload = useCallback(() => {
    setReloadTrigger(prev => prev + 1);
  }, []);

  const contextValue = useMemo(
    () => ({
      ledger,
      reloadTrigger,
      triggerReload,
    }),
    [ledger, reloadTrigger, triggerReload]
  );

  return createElement(DamlLedgerContext.Provider, { value: contextValue }, children);
};

/**
 * Hook to get the current ledger configuration
 * @internal
 */
export function useDamlLedgerContext(): DamlLedgerConfig {
  const context = useContext(DamlLedgerContext);
  if (!context) {
    throw new Error("useDamlLedgerContext must be used within a DamlLedger provider");
  }
  return context;
}

/**
 * Hook to get the ledger instance
 * @returns The Ledger instance from the context
 */
export function useLedger(): Ledger {
  const { ledger } = useDamlLedgerContext();
  return ledger;
}

/**
 * Hook to get the current user information from the token
 * @returns Object with user data, loading state, and error
 */
export function useUser(): UserResult {
  const ledger = useLedger();
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    const fetchUser = async (): Promise<void> => {
      try {
        setLoading(true);
        setError(null);
        const userInfo = await ledger.getTokenUserInfo();
        setUser(userInfo);
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err : new Error("Failed to get user info");
        setError(errorMessage);
        setUser(null);
      } finally {
        setLoading(false);
      }
    };

    void fetchUser();
  }, [ledger]);

  return { user, loading, error };
}

/**
 * Hook to get decomposed user rights
 *
 * @param userId Default to the user defined by the token.
 * @returns Object of { actAsParties, readAsParties, loading, error }
 */
export function useRightsAs(userId?: string) {
  const ledger = useLedger();
  const [actAsParties, setActAsParties] = useState<string[]>([]);
  const [readAsParties, setReadAsParties] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchActAsParties = async () => {
      try {
        const rights = await ledger.getUserInfo(userId || ledger.getTokenUserId());
        const [actAsParties, readAsParties] = (rights?.rights || []).reduce(
          (acc: [string[], string[]], right) => {
            if (right.type === "canActAs" && right.party) {
              acc[0].push(right.party);
            } else if (right.type === "canReadAs" && right.party) {
              acc[1].push(right.party);
            } else {
              console.warn(
                `This party has a right that is not canActAs or canReadAs: ${JSON.stringify(right)}`
              );
            }
            return acc;
          },
          [[], []]
        );
        setActAsParties(actAsParties);
        setReadAsParties(readAsParties);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to fetch user rights");
      } finally {
        setLoading(false);
      }
    };

    fetchActAsParties();
  }, [ledger, userId]);

  return {
    actAsParties,
    readAsParties,
    loading,
    error,
  };
}

/**
 * Hook to get a reload function for refreshing queries
 * @returns Function that can be used to trigger query reloads across all hooks
 */
export function useReload(): () => void {
  const { triggerReload } = useDamlLedgerContext();
  return triggerReload;
}

/**
 * Hook to query active contracts for a specific template
 * @param template - The template to query
 * @param options - Query options
 * @returns Query result with contracts, loading state, and reload function
 */
export function useQuery<
  TContract extends object = object,
  TKey = any,
  TTemplateId extends string = string,
>(
  template: TemplateOrInterface<TContract, TKey, TTemplateId>,
  options: QueryOptions = {}
): QueryResult<TContract, TKey> {
  const { ledger, reloadTrigger } = useDamlLedgerContext();
  const [contracts, setContracts] = useState<readonly CreateEvent<TContract, TKey>[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<Error | null>(null);

  // Extract options values to avoid object reference issues in useEffect
  const { atOffset = "end", includeCreatedEventBlob = false, readAsParties } = options;

  const reload = useCallback(async (): Promise<void> => {
    try {
      setLoading(true);
      setError(null);

      const result: CreateEvent<TContract, TKey>[] = await ledger.query(
        template as unknown as ToLedgerTemplate<TContract, TKey, TTemplateId>,
        atOffset,
        includeCreatedEventBlob,
        false, // do not care about verbose stream
        readAsParties
      );

      setContracts(result);
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err : new Error("Failed to query contracts");
      setError(errorMessage);
      setContracts([]);
    } finally {
      setLoading(false);
    }
  }, [ledger, template, atOffset, includeCreatedEventBlob]);

  // Initial load and reload when trigger changes
  useEffect(() => {
    reload();
  }, [reload, reloadTrigger]);

  return {
    contracts,
    loading,
    error,
    reload,
  };
}

/**
 * Hook to stream active contracts for a single template with real-time updates
 * @param template - The template to query
 * @param options - Query options
 * @returns Stream query result with contracts, loading state, connection status, and reload function
 */
export function useStreamQuery<
  TContract extends object = object,
  TKey = any,
  TTemplateId extends string = string,
>(
  template: TemplateOrInterface<TContract, TKey, TTemplateId>,
  options: QueryOptions = {}
): StreamQueryResult<TContract, TKey> {
  const { ledger, reloadTrigger } = useDamlLedgerContext();
  const [contractsMap, setContractsMap] = useState<
    ReadonlyMap<ContractId<TContract>, CreateEvent<TContract, TKey>>
  >(() => new Map());
  const [loading, setLoading] = useState<boolean>(true);
  const [connected, setConnected] = useState<boolean>(false);
  const [error, setError] = useState<CantonError | string | null>(null);

  // Extract options values to avoid object reference issues in useEffect
  const { atOffset = "end", includeCreatedEventBlob = false, readAsParties } = options;

  // Use refs to prevent garbage collection
  const streamRef = useRef<Stream<TContract, TKey> | null>(null);
  const isCleanedUpRef = useRef<boolean>(false);
  const reconnectTimeoutRef = useRef<number | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    // For streaming queries, reload means restarting the stream
    // The stream will handle state initialization through create/archive events
    setLoading(true);
    setError(null);
    setContractsMap(new Map());
  }, []);

  // Setup real streaming connection
  useEffect(() => {
    isCleanedUpRef.current = false;

    const setupStream = async (): Promise<void> => {
      if (isCleanedUpRef.current) return;

      try {
        setLoading(true);
        setError(null);

        // Create a stream for the template
        streamRef.current = await ledger.streamQuery<TContract, TKey>(
          template as unknown as ToLedgerTemplate<TContract, TKey, TTemplateId>,
          atOffset,
          false, // skipAcs
          includeCreatedEventBlob,
          readAsParties
        );

        // Handle new contracts
        streamRef.current.on("create", (event: CreateEvent<TContract, TKey>) => {
          setContractsMap(prevMap => new Map(prevMap).set(event.contractId, event));
        });

        // Handle archived contracts
        streamRef.current.on("archive", event => {
          setContractsMap(prevMap => {
            const newMap = new Map(prevMap);
            newMap.delete(event.contractId);
            return newMap;
          });
        });

        // Handle errors
        streamRef.current.on("error", (err: CantonError) => {
          setError(err);
          setConnected(false);
        });

        // Handle connection state
        streamRef.current.on("state", (state: StreamState) => {
          setConnected(state === "live");
          if (state === "live") {
            setLoading(false);
          }
        });

        streamRef.current.start();
      } catch (err: unknown) {
        const errorMessage =
          err instanceof Error ? `${err.name}: ${err.message}` : "Failed to setup stream";
        setError(errorMessage);
        setConnected(false);
        setLoading(false);

        // Retry on setup failure (unless cleaned up)
        if (!isCleanedUpRef.current) {
          reconnectTimeoutRef.current = setTimeout(() => {
            void setupStream();
          }, 5000);
        }
      }
    };

    void setupStream();

    return (): void => {
      // Clean up stream
      isCleanedUpRef.current = true;

      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }

      if (streamRef.current) {
        streamRef.current.close();
        streamRef.current = null;
      }
      setConnected(false);
    };
    // The template object is often unstable, so we depend on its ID instead to prevent re-renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ledger, template.templateId, atOffset, includeCreatedEventBlob, readAsParties]);

  // Handle manual reload triggers
  useEffect(() => {
    if (reloadTrigger > 0) {
      // Skip initial render (reloadTrigger starts at 0)
      reload();
    }
  }, [reloadTrigger, reload]);

  return {
    contractsMap,
    loading,
    connected,
    error,
    reload,
  };
}

/**
 * Hook to stream active contracts for multiple templates with real-time updates
 * @param templateMapping - Mapping of template IDs to their contract and key types
 * @param options - Query options
 * @returns Multi-stream query result with stream instance, loading state, connection status, and reload function
 */
export function useMultiStreamQuery<TM extends TemplateMapping>(
  templateMapping: TM,
  options: QueryOptions = {}
): MultiStreamQueryResult<TM> {
  const { ledger, reloadTrigger } = useDamlLedgerContext();
  const [multiStream, setMultiStream] = useState<MultiStream<TM> | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [connected, setConnected] = useState<boolean>(false);
  const [error, setError] = useState<CantonError | string | null>(null);

  // Extract options values to avoid object reference issues in useEffect
  const { atOffset = "end", includeCreatedEventBlob = false, readAsParties } = options;

  // Use refs to prevent garbage collection
  const streamRef = useRef<MultiStream<TM> | null>(null);
  const isCleanedUpRef = useRef<boolean>(false);
  const reconnectTimeoutRef = useRef<number | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    // For streaming queries, reload means restarting the stream
    setLoading(true);
    setError(null);
    setMultiStream(null);
  }, []);

  // Setup real streaming connection
  useEffect(() => {
    isCleanedUpRef.current = false;
    console.debug("[useMultiStreamQuery] Setting up stream with readAsParties:", readAsParties);

    const setupStream = async (): Promise<void> => {
      if (isCleanedUpRef.current) return;

      try {
        setLoading(true);
        setError(null);

        console.debug(
          "[useMultiStreamQuery] Creating new multi-stream for parties:",
          readAsParties
        );
        // Create a multi-stream for the template mapping
        streamRef.current = await ledger.createMultiStream<TM>(
          templateMapping,
          atOffset,
          false, // skipAcs
          includeCreatedEventBlob,
          readAsParties
        );

        // Handle connection state
        streamRef.current.onState((state: StreamState) => {
          setConnected(state === "live");
          if (state === "live") {
            setLoading(false);
          }
        });

        // Handle errors
        streamRef.current.onError((err: CantonError) => {
          setError(err.cause);
          setConnected(false);
        });

        setMultiStream(streamRef.current);
        streamRef.current.start();
      } catch (err: unknown) {
        const errorMessage =
          err instanceof Error ? `${err.name}: ${err.message}` : "Failed to setup multi-stream";
        setError(errorMessage);
        setConnected(false);
        setLoading(false);

        // Retry on setup failure (unless cleaned up)
        if (!isCleanedUpRef.current) {
          reconnectTimeoutRef.current = setTimeout(() => {
            void setupStream();
          }, 5000);
        }
      }
    };

    void setupStream();

    return (): void => {
      // Clean up stream
      console.debug("[useMultiStreamQuery] Cleaning up stream for parties:", readAsParties);
      isCleanedUpRef.current = true;

      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }

      if (streamRef.current) {
        streamRef.current.close();
        streamRef.current = null;
      }
      setConnected(false);
      setMultiStream(null);
    };
    // Depend on a stable representation of the template mapping and a serialized version of readAsParties
  }, [
    ledger,
    JSON.stringify(templateMapping),
    atOffset,
    includeCreatedEventBlob,
    JSON.stringify(readAsParties),
  ]);

  // Handle manual reload triggers
  useEffect(() => {
    if (reloadTrigger > 0) {
      // Skip initial render (reloadTrigger starts at 0)
      reload();
    }
  }, [reloadTrigger, reload]);

  return {
    multiStream,
    loading,
    connected,
    error,
    reload,
  };
}

/**
 * Creates a ledger context object with hooks for accessing ledger functionality
 * This maintains compatibility with @daml/react patterns while using our new implementation
 */
export function createLedgerContext() {
  return {
    DamlLedger,
    useLedger,
    useUser,
    useReload,
    useQuery,
    useStreamQuery,
    useMultiStreamQuery,
    useRightsAs,
  };
}
