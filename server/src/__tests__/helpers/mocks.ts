import { vi } from "vitest";
import type { AcsLogger } from "../../acs/types.js";
import type { CreateEvent, Interface, PackageIdString } from "@c7-digital/ledger";
import type { ContractId, Template, InterfaceCompanion } from "@daml/types";

/**
 * Creates a mock AcsLogger where all methods are vi.fn() spies.
 */
export function createMockLogger(): AcsLogger & {
  debug: ReturnType<typeof vi.fn>;
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
} {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

/**
 * Creates a minimal Template companion stub for testing.
 */
export function createMockTemplate(templateId: string): Template<any, any, PackageIdString> {
  return {
    templateId: templateId as PackageIdString,
    keyDecoder: { decoder: {} as any, type: () => ({}) },
    decoder: { decoder: {} as any, type: () => ({}) },
    Archive: {} as any,
    // Template requires these fields
  } as unknown as Template<any, any, PackageIdString>;
}

/**
 * Creates a minimal InterfaceCompanion stub for testing.
 */
export function createMockInterfaceCompanion(interfaceId: string): InterfaceCompanion<any, any, PackageIdString> {
  return {
    templateId: interfaceId as PackageIdString,
    decoder: { decoder: {} as any, type: () => ({}) },
  } as unknown as InterfaceCompanion<any, any, PackageIdString>;
}

/**
 * Creates a mock CreateEvent for template tracker testing.
 */
export function createMockCreateEvent<T extends object>(
  contractId: string,
  payload: T,
): CreateEvent<T> {
  return {
    contractId: contractId as unknown as ContractId<T>,
    payload,
    signatories: [],
    observers: [],
    createdAt: new Date().toISOString(),
  } as unknown as CreateEvent<T>;
}

/**
 * Creates a mock Interface event for interface tracker testing.
 */
export function createMockInterfaceEvent<I extends object>(
  contractId: string,
  view: I,
): Interface<I> {
  return {
    contractId: contractId as unknown as ContractId<I>,
    interfaceView: view,
    interfaceId: "test-interface-id",
  } as unknown as Interface<I>;
}
