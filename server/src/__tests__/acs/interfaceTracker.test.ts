import { describe, it, expect, vi, beforeEach } from "vitest";
import { InterfaceTracker } from "../../acs/interfaceTracker.js";
import {
  createMockLogger,
  createMockInterfaceCompanion,
  createMockInterfaceEvent,
} from "../helpers/mocks.js";
import type { ContractId } from "@daml/types";

interface TestView {
  name: string;
  amount: number;
}

describe("InterfaceTracker", () => {
  const interfaceId = "pkg:Mod:TestInterface";
  let tracker: InterfaceTracker<TestView>;
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    logger = createMockLogger();
    tracker = new InterfaceTracker(createMockInterfaceCompanion(interfaceId), logger);
  });

  describe("handleInterfaceViewed", () => {
    it("adds an interface to the map", async () => {
      const event = createMockInterfaceEvent("cid-1", { name: "Alice", amount: 100 });
      await tracker.handleInterfaceViewed(event);

      expect(tracker.getInterfaceCount()).toBe(1);
      expect(tracker.getView(event.contractId)).toEqual({ name: "Alice", amount: 100 });
    });

    it("stores the Interface event", async () => {
      const event = createMockInterfaceEvent("cid-1", { name: "Alice", amount: 100 });
      await tracker.handleInterfaceViewed(event);

      expect(tracker.getInterfaceEvent(event.contractId)).toBe(event);
    });

    it("records firstSeenAt", async () => {
      const event = createMockInterfaceEvent("cid-1", { name: "Alice", amount: 100 });
      await tracker.handleInterfaceViewed(event);

      const meta = tracker.getAllInterfacesWithMeta();
      expect(meta).toHaveLength(1);
      expect(meta[0]!.firstSeenAt).toBeDefined();
      expect(new Date(meta[0]!.firstSeenAt).getTime()).not.toBeNaN();
    });

    it("does not overwrite firstSeenAt on duplicate", async () => {
      const event1 = createMockInterfaceEvent("cid-1", { name: "Alice", amount: 100 });
      await tracker.handleInterfaceViewed(event1);
      const originalFirstSeenAt = tracker.getAllInterfacesWithMeta()[0]!.firstSeenAt;

      const event2 = createMockInterfaceEvent("cid-1", { name: "Alice", amount: 200 });
      await tracker.handleInterfaceViewed(event2);
      expect(tracker.getAllInterfacesWithMeta()[0]!.firstSeenAt).toBe(originalFirstSeenAt);
    });

    it("fires onViewed callbacks", async () => {
      const callback = vi.fn();
      tracker.onViewed("test-cb", callback);

      const event = createMockInterfaceEvent("cid-1", { name: "Alice", amount: 100 });
      await tracker.handleInterfaceViewed(event);

      expect(callback).toHaveBeenCalledWith(event.contractId, event.interfaceView, event);
    });

    it("catches callback errors without throwing", async () => {
      tracker.onViewed("bad-cb", () => {
        throw new Error("callback failed");
      });

      const event = createMockInterfaceEvent("cid-1", { name: "Alice", amount: 100 });
      await expect(tracker.handleInterfaceViewed(event)).resolves.not.toThrow();
      expect(logger.error).toHaveBeenCalled();
    });

    it("increments count for multiple interfaces", async () => {
      await tracker.handleInterfaceViewed(createMockInterfaceEvent("cid-1", { name: "A", amount: 1 }));
      await tracker.handleInterfaceViewed(createMockInterfaceEvent("cid-2", { name: "B", amount: 2 }));

      expect(tracker.getInterfaceCount()).toBe(2);
    });
  });

  describe("relevanceFn", () => {
    it("filters irrelevant interfaces", async () => {
      const relevantTracker = new InterfaceTracker(
        createMockInterfaceCompanion(interfaceId),
        logger,
        (v: TestView) => v.name === "Alice",
      );

      await relevantTracker.handleInterfaceViewed(
        createMockInterfaceEvent("cid-1", { name: "Bob", amount: 10 }),
      );

      expect(relevantTracker.getInterfaceCount()).toBe(0);
      expect(logger.warn).toHaveBeenCalled();
    });

    it("accepts relevant interfaces", async () => {
      const relevantTracker = new InterfaceTracker(
        createMockInterfaceCompanion(interfaceId),
        logger,
        (v: TestView) => v.name === "Alice",
      );

      await relevantTracker.handleInterfaceViewed(
        createMockInterfaceEvent("cid-1", { name: "Alice", amount: 10 }),
      );

      expect(relevantTracker.getInterfaceCount()).toBe(1);
    });

    it("skips callbacks for filtered interfaces", async () => {
      const relevantTracker = new InterfaceTracker(
        createMockInterfaceCompanion(interfaceId),
        logger,
        (v: TestView) => v.name === "Alice",
      );
      const callback = vi.fn();
      relevantTracker.onViewed("cb", callback);

      await relevantTracker.handleInterfaceViewed(
        createMockInterfaceEvent("cid-1", { name: "Bob", amount: 10 }),
      );

      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe("handleInterfaceArchived", () => {
    it("removes interface from the map", async () => {
      const event = createMockInterfaceEvent("cid-1", { name: "Alice", amount: 100 });
      await tracker.handleInterfaceViewed(event);
      expect(tracker.getInterfaceCount()).toBe(1);

      await tracker.handleInterfaceArchived(event.contractId);
      expect(tracker.getInterfaceCount()).toBe(0);
      expect(tracker.getView(event.contractId)).toBeUndefined();
    });

    it("fires onArchived callbacks with view", async () => {
      const callback = vi.fn();
      tracker.onArchived("archive-cb", callback);

      const event = createMockInterfaceEvent("cid-1", { name: "Alice", amount: 100 });
      await tracker.handleInterfaceViewed(event);
      await tracker.handleInterfaceArchived(event.contractId);

      expect(callback).toHaveBeenCalledWith(event.contractId, { name: "Alice", amount: 100 });
    });

    it("catches callback errors", async () => {
      tracker.onArchived("bad-cb", () => {
        throw new Error("archive callback failed");
      });

      const event = createMockInterfaceEvent("cid-1", { name: "Alice", amount: 100 });
      await tracker.handleInterfaceViewed(event);
      await expect(tracker.handleInterfaceArchived(event.contractId)).resolves.not.toThrow();
      expect(logger.error).toHaveBeenCalled();
    });

    it("is a no-op for unknown contractId", async () => {
      const callback = vi.fn();
      tracker.onArchived("cb", callback);

      await tracker.handleInterfaceArchived("unknown-id" as unknown as ContractId<TestView>);
      expect(callback).not.toHaveBeenCalled();
    });

    it("removes firstSeenAt entry", async () => {
      const event = createMockInterfaceEvent("cid-1", { name: "Alice", amount: 100 });
      await tracker.handleInterfaceViewed(event);
      await tracker.handleInterfaceArchived(event.contractId);

      expect(tracker.getAllInterfacesWithMeta()).toHaveLength(0);
    });
  });

  describe("getAllInterfaces / getAllInterfaceEvents / getAllInterfacesWithMeta", () => {
    it("getAllInterfaces returns Map of contractId → view", async () => {
      await tracker.handleInterfaceViewed(createMockInterfaceEvent("cid-1", { name: "A", amount: 1 }));
      await tracker.handleInterfaceViewed(createMockInterfaceEvent("cid-2", { name: "B", amount: 2 }));

      const interfaces = tracker.getAllInterfaces();
      expect(interfaces.size).toBe(2);
      expect(interfaces.get("cid-1" as unknown as ContractId<TestView>)).toEqual({ name: "A", amount: 1 });
    });

    it("getAllInterfaceEvents returns Map of contractId → Interface event", async () => {
      const event = createMockInterfaceEvent("cid-1", { name: "A", amount: 1 });
      await tracker.handleInterfaceViewed(event);

      const events = tracker.getAllInterfaceEvents();
      expect(events.size).toBe(1);
      expect(events.get(event.contractId)).toBe(event);
    });

    it("getAllInterfacesWithMeta returns array with firstSeenAt", async () => {
      await tracker.handleInterfaceViewed(createMockInterfaceEvent("cid-1", { name: "A", amount: 1 }));

      const meta = tracker.getAllInterfacesWithMeta();
      expect(meta).toHaveLength(1);
      expect(meta[0]).toHaveProperty("contractId");
      expect(meta[0]).toHaveProperty("view");
      expect(meta[0]).toHaveProperty("firstSeenAt");
    });
  });

  describe("hasInterface", () => {
    it("returns true for existing interface", async () => {
      const event = createMockInterfaceEvent("cid-1", { name: "A", amount: 1 });
      await tracker.handleInterfaceViewed(event);
      expect(tracker.hasInterface(event.contractId)).toBe(true);
    });

    it("returns false for non-existing interface", () => {
      expect(tracker.hasInterface("cid-x" as unknown as ContractId<TestView>)).toBe(false);
    });
  });

  describe("getInterfaceId", () => {
    it("returns the configured interfaceId", () => {
      expect(tracker.getInterfaceId()).toBe(interfaceId);
    });
  });

  describe("callbacks", () => {
    it("throws on duplicate viewed callback key", () => {
      tracker.onViewed("dup", vi.fn());
      expect(() => tracker.onViewed("dup", vi.fn())).toThrow("Callback with key dup already exists");
    });

    it("throws on duplicate archived callback key", () => {
      tracker.onArchived("dup", vi.fn());
      expect(() => tracker.onArchived("dup", vi.fn())).toThrow("Callback with key dup already exists");
    });

    it("removes viewed callback", async () => {
      const cb = vi.fn();
      tracker.onViewed("key1", cb);
      tracker.removeViewedCallback("key1");

      await tracker.handleInterfaceViewed(createMockInterfaceEvent("cid-1", { name: "A", amount: 1 }));
      expect(cb).not.toHaveBeenCalled();
    });

    it("removes archived callback", async () => {
      const cb = vi.fn();
      tracker.onArchived("key1", cb);
      tracker.removeArchivedCallback("key1");

      const event = createMockInterfaceEvent("cid-1", { name: "A", amount: 1 });
      await tracker.handleInterfaceViewed(event);
      await tracker.handleInterfaceArchived(event.contractId);
      expect(cb).not.toHaveBeenCalled();
    });
  });

  describe("cleanup", () => {
    it("clears interfaces and callbacks", async () => {
      tracker.onViewed("cb", vi.fn());
      tracker.onArchived("cb", vi.fn());
      await tracker.handleInterfaceViewed(createMockInterfaceEvent("cid-1", { name: "A", amount: 1 }));

      tracker.cleanup();

      expect(tracker.getInterfaceCount()).toBe(0);
      expect(() => tracker.onViewed("cb", vi.fn())).not.toThrow();
      expect(() => tracker.onArchived("cb", vi.fn())).not.toThrow();
    });
  });
});
