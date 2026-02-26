import { describe, it, expect } from "vitest";
import {
  TypeSafeTrackerRegistry,
  TypeSafeInterfaceTrackerRegistry,
} from "../../acs/registries.js";
import type { PackageIdString } from "@c7-digital/ledger";

describe("TypeSafeTrackerRegistry", () => {
  const id1 = "pkg1:Mod:Template1" as PackageIdString;
  const id2 = "pkg2:Mod:Template2" as PackageIdString;

  it("starts empty", () => {
    const registry = new TypeSafeTrackerRegistry();
    expect(registry.length()).toBe(0);
    expect(registry.has(id1)).toBe(false);
  });

  it("stores and retrieves a tracker", () => {
    const registry = new TypeSafeTrackerRegistry();
    const tracker = { mock: true } as any;
    registry.set(id1, tracker);
    expect(registry.get(id1)).toBe(tracker);
  });

  it("returns undefined for missing key", () => {
    const registry = new TypeSafeTrackerRegistry();
    expect(registry.get(id1)).toBeUndefined();
  });

  it("has() returns true for set keys", () => {
    const registry = new TypeSafeTrackerRegistry();
    registry.set(id1, {} as any);
    expect(registry.has(id1)).toBe(true);
    expect(registry.has(id2)).toBe(false);
  });

  it("reports correct length", () => {
    const registry = new TypeSafeTrackerRegistry();
    registry.set(id1, {} as any);
    registry.set(id2, {} as any);
    expect(registry.length()).toBe(2);
  });

  it("iterates values", () => {
    const registry = new TypeSafeTrackerRegistry();
    const t1 = { id: 1 } as any;
    const t2 = { id: 2 } as any;
    registry.set(id1, t1);
    registry.set(id2, t2);
    const values = Array.from(registry.values());
    expect(values).toContain(t1);
    expect(values).toContain(t2);
  });

  it("iterates keys", () => {
    const registry = new TypeSafeTrackerRegistry();
    registry.set(id1, {} as any);
    registry.set(id2, {} as any);
    const keys = Array.from(registry.keys());
    expect(keys).toContain(id1);
    expect(keys).toContain(id2);
  });
});

describe("TypeSafeInterfaceTrackerRegistry", () => {
  const id1 = "pkg1:Mod:Iface1" as PackageIdString;
  const id2 = "pkg2:Mod:Iface2" as PackageIdString;

  it("starts empty", () => {
    const registry = new TypeSafeInterfaceTrackerRegistry();
    expect(registry.length()).toBe(0);
    expect(registry.has(id1)).toBe(false);
  });

  it("stores and retrieves a tracker", () => {
    const registry = new TypeSafeInterfaceTrackerRegistry();
    const tracker = { mock: true } as any;
    registry.set(id1, tracker);
    expect(registry.get(id1)).toBe(tracker);
  });

  it("returns undefined for missing key", () => {
    const registry = new TypeSafeInterfaceTrackerRegistry();
    expect(registry.get(id1)).toBeUndefined();
  });

  it("has() returns true for set keys", () => {
    const registry = new TypeSafeInterfaceTrackerRegistry();
    registry.set(id1, {} as any);
    expect(registry.has(id1)).toBe(true);
    expect(registry.has(id2)).toBe(false);
  });

  it("reports correct length", () => {
    const registry = new TypeSafeInterfaceTrackerRegistry();
    registry.set(id1, {} as any);
    registry.set(id2, {} as any);
    expect(registry.length()).toBe(2);
  });

  it("iterates values", () => {
    const registry = new TypeSafeInterfaceTrackerRegistry();
    const t1 = { id: 1 } as any;
    const t2 = { id: 2 } as any;
    registry.set(id1, t1);
    registry.set(id2, t2);
    const values = Array.from(registry.values());
    expect(values).toContain(t1);
    expect(values).toContain(t2);
  });

  it("iterates keys", () => {
    const registry = new TypeSafeInterfaceTrackerRegistry();
    registry.set(id1, {} as any);
    registry.set(id2, {} as any);
    const keys = Array.from(registry.keys());
    expect(keys).toContain(id1);
    expect(keys).toContain(id2);
  });
});
