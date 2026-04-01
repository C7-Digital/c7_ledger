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
import type { InterfaceCompanion, Template, ContractId } from "@daml/types";
import {
  Ledger,
  type ArchiveEvent,
  type LedgerOptions,
  type CreateEvent,
  type CantonError,
  type StreamState,
  type User,
  type MultiStream,
  type TemplateMapping,
  type InterfaceMapping,
  type InterfaceMultiStream,
  type PackageIdString,
  type Interface,
} from "@c7-digital/ledger/lite";
import type {
  DamlLedgerConfig,
  QueryOptions,
  QueryResult,
  InterfaceQueryResult,
  StreamQueryResult,
  StreamQueryInterfaceResult,
  UserResult,
  MultiStreamQueryResult,
  MultiStreamInterfaceQueryResult,
} from "./types";

// Utility type to convert template with literal string ID to PackageIdString for ledger compatibility
type ToLedgerTemplate<
  TContract extends object,
  TKey,
  // @ts-ignore
  TTemplateId extends string,
> = Template<TContract, TKey, PackageIdString>;

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
  const { children, token, ...otherOptions } = props;

  const [reloadTrigger, setReloadTrigger] = useState(0);

  // Capture initial options on first render and never change them
  // These options should be static for the lifetime of the component
  const initialOptionsRef = useRef(otherOptions);

  // Create ledger once. Token updates are pushed via setToken() below.
  // Only recreate when reloadTrigger changes (explicit reload requested).
  const ledger = useMemo(() => {
    return new Ledger({ ...initialOptionsRef.current, token });
  }, [reloadTrigger]);

  // When the token prop changes, update the ledger's HTTP token in-place.
  // Streams are notified separately via the onTokenChange callback below.
  const prevTokenRef = useRef(token);
  useEffect(() => {
    if (token !== prevTokenRef.current) {
      console.log(`[DamlLedger] Token refreshed, updating ledger (prev: ...${prevTokenRef.current?.slice(-10)}, new: ...${token?.slice(-10)})`);
      prevTokenRef.current = token;
      ledger.setToken(token);
    }
  }, [token, ledger]);

  const triggerReload = useCallback(() => {
    setReloadTrigger(prev => prev + 1);
  }, []);

  const contextValue = useMemo(
    () => ({
      ledger,
      token,
      reloadTrigger,
      triggerReload,
    }),
    [ledger, token, reloadTrigger, triggerReload]
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
  template: Template<TContract, TKey, TTemplateId>,
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
 * Hook to query interface views for a specific interface
 * @param interface_ - The Daml interface to query
 * @param options - Query options
 * @returns Query result with contracts, loading state, and reload function
 */
export function useQueryInterface<
  TInterface extends object = object,
  TKey = unknown,
  TInterfaceId extends string = string,
>(
  interface_: InterfaceCompanion<TInterface, TKey, TInterfaceId>,
  options: QueryOptions = {}
): InterfaceQueryResult<TInterface> {
  const { ledger, reloadTrigger } = useDamlLedgerContext();
  const [interfaces, setInterfaces] = useState<readonly Interface<TInterface>[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<Error | null>(null);

  // Extract options values to avoid object reference issues in useEffect
  const { atOffset = "end", includeCreatedEventBlob = false, readAsParties } = options;

  const reload = useCallback(async (): Promise<void> => {
    try {
      setLoading(true);
      setError(null);

      const result: Interface<TInterface>[] = await ledger.queryInterface(
        interface_ as unknown as ToLedgerTemplate<TInterface, TKey, TInterfaceId>,
        atOffset,
        includeCreatedEventBlob,
        false, // do not care about verbose stream
        readAsParties
      );

      setInterfaces(result);
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err : new Error("Failed to query contracts");
      setError(errorMessage);
      setInterfaces([]);
    } finally {
      setLoading(false);
    }
  }, [ledger, interface_, atOffset, includeCreatedEventBlob]);

  // Initial load and reload when trigger changes
  useEffect(() => {
    reload();
  }, [reload, reloadTrigger]);

  return {
    interfaces,
    loading,
    error,
    reload,
  };
}



/**
 * Base hook for streaming functionality - handles common state management and lifecycle
 */
function useStreamBase<
  TContract extends object = object,
  TKey = unknown,
  TStream extends { on: Function; off: Function; start: Function; close: Function; updateToken: Function } = any
>(
  createStream: () => Promise<TStream>,
  setupAdditionalEventHandlers?: (stream: TStream) => void,
  dependencies: any[] = []
) {
  const { reloadTrigger, token } = useDamlLedgerContext();
  const [contractsMap, setContractsMap] = useState<
    ReadonlyMap<ContractId<TContract>, CreateEvent<TContract, TKey>>
  >(() => new Map());
  const [loading, setLoading] = useState<boolean>(true);
  const [connected, setConnected] = useState<boolean>(false);
  const [error, setError] = useState<CantonError | string | null>(null);

  // Use refs to prevent garbage collection
  const streamRef = useRef<TStream | null>(null);
  const isCleanedUpRef = useRef<boolean>(false);
  const reconnectTimeoutRef = useRef<number | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    setContractsMap(new Map());
  }, []);

  const updateToken = useCallback((newToken: string): void => {
    if (streamRef.current) {
      streamRef.current.updateToken(newToken);
    }
  }, []);

  // Automatically push token updates to the active stream
  const prevStreamTokenRef = useRef(token);
  useEffect(() => {
    if (token !== prevStreamTokenRef.current) {
      prevStreamTokenRef.current = token;
      updateToken(token);
    }
  }, [token, updateToken]);

  // Setup real streaming connection
  useEffect(() => {
    isCleanedUpRef.current = false;

    const setupStream = async (): Promise<void> => {
      if (isCleanedUpRef.current) return;

      try {
        setLoading(true);
        setError(null);

        streamRef.current = await createStream();

        // Handle common create events
        streamRef.current.on("create", (event: CreateEvent<TContract, TKey>) => {
          setContractsMap((prevMap: ReadonlyMap<ContractId<TContract>, CreateEvent<TContract, TKey>>) => 
            new Map(prevMap).set(event.contractId, event)
          );
        });

        // Handle common archive events
        streamRef.current.on("archive", (event: any) => {
          setContractsMap((prevMap: ReadonlyMap<ContractId<TContract>, CreateEvent<TContract, TKey>>) => {
            const newMap = new Map(prevMap);
            newMap.delete(event.contractId);
            return newMap;
          });
        });

        // Setup additional event handlers (e.g., interfaceView for interface streams)
        if (setupAdditionalEventHandlers) {
          setupAdditionalEventHandlers(streamRef.current);
        }

        // Common error and state handling
        streamRef.current.on("error", (err: CantonError) => {
          setError(err.cause);
          setConnected(false);
        });

        streamRef.current.on("state", (state: StreamState) => {
          setConnected(state === "live");
          if (state === "live") {
            setLoading(false);
          }
        });

        streamRef.current.start();
      } catch (err) {
        if (!isCleanedUpRef.current) {
          const errorMessage = err instanceof Error ? `${err.name}: ${err.message}` : "Failed to setup stream";
          setError(errorMessage);
          setConnected(false);
          setLoading(false);

          reconnectTimeoutRef.current = setTimeout(() => {
            void setupStream();
          }, 5000);
        }
      }
    };

    void setupStream();

    return (): void => {
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
  }, dependencies);

  // Handle manual reload triggers
  useEffect(() => {
    if (reloadTrigger > 0) {
      reload();
    }
  }, [reloadTrigger, reload]);

  return {
    contractsMap,
    loading,
    connected,
    error,
    reload,
    updateToken,
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
  template: Template<TContract, TKey, TTemplateId>,
  options: QueryOptions = {}
): StreamQueryResult<TContract, TKey> {
  const { ledger } = useDamlLedgerContext();
  const { atOffset = "end", includeCreatedEventBlob = false, readAsParties } = options;

  const result = useStreamBase<TContract, TKey>(
    () => ledger.streamQuery(template, atOffset, false, includeCreatedEventBlob, readAsParties),
    undefined, // No additional event handlers needed for template streaming
    [ledger, template.templateId, atOffset, includeCreatedEventBlob, readAsParties]
  );

  // Return only the fields expected by StreamQueryResult (without interfacesMap)
  return {
    ...result,
    contractsMap: result.contractsMap as ReadonlyMap<ContractId<TContract>, CreateEvent<TContract, TKey>>,
  };
}

/**
 * Hook to stream active contracts for a single interface with real-time updates
 * @param interface_ - The interface to query
 * @param options - Query options
 * @returns Stream query result with contracts, loading state, connection status, and reload function
 */
export function useStreamQueryInterface<
  IContract extends object = object,
  IId extends string = string,
>(
  interface_: InterfaceCompanion<IContract, unknown, IId>,
  options: QueryOptions = {}
): StreamQueryInterfaceResult<IContract> {
  const { ledger } = useDamlLedgerContext();
  const { atOffset = "end", includeCreatedEventBlob = false, readAsParties } = options;

  // Manage interfacesMap state locally since it's interface-specific
  const [interfacesMap, setInterfacesMap] = useState<
    ReadonlyMap<ContractId<IContract>, Interface<IContract>>
  >(() => new Map());

  const result = useStreamBase<object, unknown>(
    () => ledger.streamQueryInterface(interface_, atOffset, false, includeCreatedEventBlob, readAsParties),
    (stream) => {
      // Handle interface view events (create/archive handled by base hook)
      stream.on("interfaceView", (interfaceEvent: Interface<IContract>) => {
        setInterfacesMap((prevMap: ReadonlyMap<ContractId<IContract>, Interface<IContract>>) => 
          new Map(prevMap).set(interfaceEvent.contractId, interfaceEvent)
        );
      });

      // Handle archived contracts for interfacesMap (contractsMap handled by base hook)
      stream.on("archive", (event: ArchiveEvent<IContract>) => {
        setInterfacesMap((prevMap: ReadonlyMap<ContractId<IContract>, Interface<IContract>>) => {
          const newMap = new Map(prevMap);
          newMap.delete(event.contractId as ContractId<IContract>);
          return newMap;
        });
      });
    },
    [ledger, interface_.templateId, atOffset, includeCreatedEventBlob, readAsParties]
  );

  // Override the base hook's reload to also clear interfacesMap
  const reload = useCallback(async (): Promise<void> => {
    setInterfacesMap(new Map());
    await result.reload();
  }, [result.reload]);

  return {
    ...result,
    contractsMap: result.contractsMap as ReadonlyMap<ContractId<object>, CreateEvent<object, unknown>>,
    interfacesMap,
    reload, // Override with our custom reload that also clears interfacesMap
  };
}

/**
 * Base hook for multi-stream functionality - handles common state management and lifecycle
 */
function useMultiStreamBase<TStream extends { onState: Function; onError: Function; start: Function; close: Function; updateToken: Function }>(
  createStream: () => Promise<TStream>,
  dependencies: any[]
) {
  const { reloadTrigger, token } = useDamlLedgerContext();
  const [multiStream, setMultiStream] = useState<TStream | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [connected, setConnected] = useState<boolean>(false);
  const [error, setError] = useState<CantonError | string | null>(null);

  // Use refs to prevent garbage collection
  const streamRef = useRef<TStream | null>(null);
  const isCleanedUpRef = useRef<boolean>(false);
  const reconnectTimeoutRef = useRef<number | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    setMultiStream(null);
  }, []);

  const updateToken = useCallback((newToken: string): void => {
    if (streamRef.current) {
      streamRef.current.updateToken(newToken);
    }
  }, []);

  // Automatically push token updates to the active multi-stream
  const prevMultiStreamTokenRef = useRef(token);
  useEffect(() => {
    if (token !== prevMultiStreamTokenRef.current) {
      prevMultiStreamTokenRef.current = token;
      updateToken(token);
    }
  }, [token, updateToken]);

  // Setup real streaming connection
  useEffect(() => {
    isCleanedUpRef.current = false;

    const setupStream = async (): Promise<void> => {
      if (isCleanedUpRef.current) return;

      try {
        setLoading(true);
        setError(null);

        streamRef.current = await createStream();

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
  }, dependencies);

  // Handle manual reload triggers
  useEffect(() => {
    if (reloadTrigger > 0) {
      reload();
    }
  }, [reloadTrigger, reload]);

  return {
    multiStream,
    loading,
    connected,
    error,
    reload,
    updateToken,
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
  const { ledger } = useDamlLedgerContext();
  const { atOffset = "end", includeCreatedEventBlob = false, readAsParties } = options;

  const result = useMultiStreamBase(
    () => ledger.createMultiStream<TM>(
      templateMapping,
      atOffset,
      false, // skipAcs
      includeCreatedEventBlob,
      readAsParties
    ),
    [
      ledger,
      JSON.stringify(templateMapping),
      atOffset,
      includeCreatedEventBlob,
      JSON.stringify(readAsParties),
    ]
  );

  return {
    ...result,
    multiStream: result.multiStream as MultiStream<TM> | null,
  };
}

/**
 * Hook to stream active contracts for multiple interfaces with real-time updates
 * @param interfaceMapping - Mapping of interface IDs to their contract types
 * @param options - Query options
 * @returns Multi-stream query result with stream instance, loading state, connection status, and reload function
 */
export function useMultiStreamInterfaceQuery<IM extends InterfaceMapping>(
  interfaceMapping: IM,
  options: QueryOptions = {}
): MultiStreamInterfaceQueryResult<IM> {
  const { ledger } = useDamlLedgerContext();
  const { atOffset = "end", includeCreatedEventBlob = false, readAsParties } = options;

  const result = useMultiStreamBase(
    () => ledger.createMultiInterfaceStream<IM>(
      interfaceMapping,
      atOffset,
      false, // skipAcs
      includeCreatedEventBlob,
      readAsParties
    ),
    [
      ledger,
      JSON.stringify(interfaceMapping),
      atOffset,
      includeCreatedEventBlob,
      JSON.stringify(readAsParties),
    ]
  );

  return {
    ...result,
    multiStream: result.multiStream as InterfaceMultiStream<IM> | null,
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
    useQueryInterface,
    useStreamQuery,
    useStreamQueryInterface,
    useMultiStreamQuery,
    useMultiStreamInterfaceQuery,
    useRightsAs,
  };
}
