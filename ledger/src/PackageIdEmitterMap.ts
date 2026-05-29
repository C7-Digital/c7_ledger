import { EventEmitter } from "eventemitter3";
import { IdentifierString } from "./valueTypes";
import { partiallyQualified } from "./util";

/**
 * A specialized Map wrapper for package ID emitters that uses partiallyQualified
 * IDs for comparison to ensure consistent lookup regardless of package ID.
 * Can be used for both template IDs and interface IDs.
 */
export class PackageIdEmitterMap {
  private emitters: Map<string, { fullId: IdentifierString; emitter: EventEmitter }> = new Map();

  /**
   * Set an EventEmitter for a specific package ID
   * @param packageId The full package ID (template or interface)
   * @param emitter The EventEmitter instance
   */
  set(packageId: IdentifierString, emitter: EventEmitter): void {
    const partialId = partiallyQualified(packageId);
    this.emitters.set(partialId, { fullId: packageId, emitter });
  }

  /**
   * Get the EventEmitter for a specific package ID
   * @param packageId The package ID (full or partial)
   * @returns The EventEmitter or undefined if not found
   */
  get(packageId: IdentifierString): EventEmitter | undefined {
    const partialId = partiallyQualified(packageId);
    return this.emitters.get(partialId)?.emitter;
  }

  /**
   * Check if an emitter exists for a specific package ID
   * @param packageId The package ID (full or partial)
   * @returns True if an emitter exists, false otherwise
   */
  has(packageId: IdentifierString): boolean {
    const partialId = partiallyQualified(packageId);
    return this.emitters.has(partialId);
  }

  /**
   * Get all emitters in the map
   * @returns An iterator of all EventEmitter instances
   */
  values(): IterableIterator<EventEmitter> {
    return Array.from(this.emitters.values())
      .map(entry => entry.emitter)
      [Symbol.iterator]();
  }

  /**
   * Clear all emitters from the map
   */
  clear(): void {
    this.emitters.clear();
  }

  /**
   * Get the number of emitters in the map
   */
  get size(): number {
    return this.emitters.size;
  }
}

// Backward compatibility alias
export const TemplateEmitterMap = PackageIdEmitterMap;
