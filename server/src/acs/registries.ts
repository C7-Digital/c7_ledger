import { PackageIdString } from "@c7-digital/ledger";
import type { TemplateTracker } from "./templateTracker.js";
import type { InterfaceTracker } from "./interfaceTracker.js";
import type { TrackerRegistry, InterfaceTrackerRegistry } from "./types.js";

export class TypeSafeTrackerRegistry implements TrackerRegistry {
  private internal = new Map<PackageIdString, TemplateTracker<any>>();

  get<T extends object>(templateId: PackageIdString): TemplateTracker<T> | undefined {
    const tracker = this.internal.get(templateId);
    return tracker as TemplateTracker<T> | undefined;
  }

  set<T extends object>(templateId: PackageIdString, tracker: TemplateTracker<T>): void {
    this.internal.set(templateId, tracker);
  }

  has(templateId: PackageIdString): boolean {
    return this.internal.has(templateId);
  }

  length(): number {
    return this.internal.size;
  }

  values(): Iterable<TemplateTracker<any>> {
    return this.internal.values();
  }

  keys(): Iterable<PackageIdString> {
    return this.internal.keys();
  }
}

export class TypeSafeInterfaceTrackerRegistry implements InterfaceTrackerRegistry {
  private internal = new Map<PackageIdString, InterfaceTracker<any>>();

  get<T extends object>(interfaceId: PackageIdString): InterfaceTracker<T> | undefined {
    const tracker = this.internal.get(interfaceId);
    return tracker as InterfaceTracker<T> | undefined;
  }

  set<T extends object>(interfaceId: PackageIdString, tracker: InterfaceTracker<T>): void {
    this.internal.set(interfaceId, tracker);
  }

  has(interfaceId: PackageIdString): boolean {
    return this.internal.has(interfaceId);
  }

  length(): number {
    return this.internal.size;
  }

  values(): Iterable<InterfaceTracker<any>> {
    return this.internal.values();
  }

  keys(): Iterable<PackageIdString> {
    return this.internal.keys();
  }
}
