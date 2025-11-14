import { EventEmitter } from "eventemitter3";
import { PackageIdString } from "./valueTypes";
import { partiallyQualified } from "./util";

/**
 * A specialized Map wrapper for template emitters that uses partiallyQualified
 * template IDs for comparison to ensure consistent lookup regardless of package ID.
 */
export class TemplateEmitterMap {
  private emitters: Map<string, { fullId: PackageIdString; emitter: EventEmitter }> = new Map();

  /**
   * Set an EventEmitter for a specific template ID
   * @param templateId The full template ID
   * @param emitter The EventEmitter instance
   */
  set(templateId: PackageIdString, emitter: EventEmitter): void {
    const partialId = partiallyQualified(templateId);
    this.emitters.set(partialId, { fullId: templateId, emitter });
  }

  /**
   * Get the EventEmitter for a specific template ID
   * @param templateId The template ID (full or partial)
   * @returns The EventEmitter or undefined if not found
   */
  get(templateId: PackageIdString): EventEmitter | undefined {
    const partialId = partiallyQualified(templateId);
    return this.emitters.get(partialId)?.emitter;
  }

  /**
   * Check if an emitter exists for a specific template ID
   * @param templateId The template ID (full or partial)
   * @returns True if an emitter exists, false otherwise
   */
  has(templateId: PackageIdString): boolean {
    const partialId = partiallyQualified(templateId);
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
