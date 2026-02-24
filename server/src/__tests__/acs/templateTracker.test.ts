import { describe, it, expect, vi, beforeEach } from "vitest";
import { TemplateTracker } from "../../acs/templateTracker.js";
import {
  createMockLogger,
  createMockTemplate,
  createMockCreateEvent,
} from "../helpers/mocks.js";
import type { ContractId } from "@daml/types";

interface TestPayload {
  owner: string;
  value: number;
}

describe("TemplateTracker", () => {
  const templateId = "pkg:Mod:TestTemplate";
  let tracker: TemplateTracker<TestPayload>;
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    logger = createMockLogger();
    tracker = new TemplateTracker(createMockTemplate(templateId), logger);
  });

  describe("handleContractCreated", () => {
    it("adds a contract to the map", async () => {
      const event = createMockCreateEvent("cid-1", { owner: "Alice", value: 10 });
      await tracker.handleContractCreated(event);

      expect(tracker.getContractCount()).toBe(1);
      expect(tracker.getPayload(event.contractId)).toEqual({ owner: "Alice", value: 10 });
    });

    it("stores the CreateEvent", async () => {
      const event = createMockCreateEvent("cid-1", { owner: "Alice", value: 10 });
      await tracker.handleContractCreated(event);

      expect(tracker.getCreateEvent(event.contractId)).toBe(event);
    });

    it("records firstSeenAt", async () => {
      const event = createMockCreateEvent("cid-1", { owner: "Alice", value: 10 });
      await tracker.handleContractCreated(event);

      const meta = tracker.getAllContractsWithMeta();
      expect(meta).toHaveLength(1);
      expect(meta[0]!.firstSeenAt).toBeDefined();
      expect(new Date(meta[0]!.firstSeenAt).getTime()).not.toBeNaN();
    });

    it("does not overwrite firstSeenAt on duplicate", async () => {
      const event1 = createMockCreateEvent("cid-1", { owner: "Alice", value: 10 });
      await tracker.handleContractCreated(event1);
      const firstMeta = tracker.getAllContractsWithMeta();
      const originalFirstSeenAt = firstMeta[0]!.firstSeenAt;

      // Re-create same contractId with different payload
      const event2 = createMockCreateEvent("cid-1", { owner: "Alice", value: 20 });
      await tracker.handleContractCreated(event2);
      const secondMeta = tracker.getAllContractsWithMeta();

      expect(secondMeta[0]!.firstSeenAt).toBe(originalFirstSeenAt);
    });

    it("fires onCreated callbacks", async () => {
      const callback = vi.fn();
      tracker.onCreated("test-cb", callback);

      const event = createMockCreateEvent("cid-1", { owner: "Alice", value: 10 });
      await tracker.handleContractCreated(event);

      expect(callback).toHaveBeenCalledWith(event.contractId, event.payload, event);
    });

    it("catches callback errors without throwing", async () => {
      tracker.onCreated("bad-cb", () => {
        throw new Error("callback failed");
      });

      const event = createMockCreateEvent("cid-1", { owner: "Alice", value: 10 });
      await expect(tracker.handleContractCreated(event)).resolves.not.toThrow();
      expect(logger.error).toHaveBeenCalled();
    });

    it("increments contract count for multiple contracts", async () => {
      await tracker.handleContractCreated(createMockCreateEvent("cid-1", { owner: "A", value: 1 }));
      await tracker.handleContractCreated(createMockCreateEvent("cid-2", { owner: "B", value: 2 }));

      expect(tracker.getContractCount()).toBe(2);
    });
  });

  describe("relevanceFn", () => {
    it("filters irrelevant contracts", async () => {
      const relevantTracker = new TemplateTracker(
        createMockTemplate(templateId),
        logger,
        (p: TestPayload) => p.owner === "Alice",
      );

      const event = createMockCreateEvent("cid-1", { owner: "Bob", value: 10 });
      await relevantTracker.handleContractCreated(event);

      expect(relevantTracker.getContractCount()).toBe(0);
      expect(logger.warn).toHaveBeenCalled();
    });

    it("accepts relevant contracts", async () => {
      const relevantTracker = new TemplateTracker(
        createMockTemplate(templateId),
        logger,
        (p: TestPayload) => p.owner === "Alice",
      );

      const event = createMockCreateEvent("cid-1", { owner: "Alice", value: 10 });
      await relevantTracker.handleContractCreated(event);

      expect(relevantTracker.getContractCount()).toBe(1);
    });

    it("skips callbacks for filtered contracts", async () => {
      const relevantTracker = new TemplateTracker(
        createMockTemplate(templateId),
        logger,
        (p: TestPayload) => p.owner === "Alice",
      );
      const callback = vi.fn();
      relevantTracker.onCreated("cb", callback);

      await relevantTracker.handleContractCreated(
        createMockCreateEvent("cid-1", { owner: "Bob", value: 10 }),
      );

      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe("handleContractArchived", () => {
    it("removes contract from the map", async () => {
      const event = createMockCreateEvent("cid-1", { owner: "Alice", value: 10 });
      await tracker.handleContractCreated(event);
      expect(tracker.getContractCount()).toBe(1);

      await tracker.handleContractArchived(event.contractId);
      expect(tracker.getContractCount()).toBe(0);
      expect(tracker.getPayload(event.contractId)).toBeUndefined();
    });

    it("fires onArchived callbacks with payload", async () => {
      const callback = vi.fn();
      tracker.onArchived("archive-cb", callback);

      const event = createMockCreateEvent("cid-1", { owner: "Alice", value: 10 });
      await tracker.handleContractCreated(event);
      await tracker.handleContractArchived(event.contractId);

      expect(callback).toHaveBeenCalledWith(event.contractId, { owner: "Alice", value: 10 });
    });

    it("catches callback errors", async () => {
      tracker.onArchived("bad-archive-cb", () => {
        throw new Error("archive callback failed");
      });

      const event = createMockCreateEvent("cid-1", { owner: "Alice", value: 10 });
      await tracker.handleContractCreated(event);
      await expect(tracker.handleContractArchived(event.contractId)).resolves.not.toThrow();
      expect(logger.error).toHaveBeenCalled();
    });

    it("is a no-op for unknown contractId", async () => {
      const callback = vi.fn();
      tracker.onArchived("cb", callback);

      await tracker.handleContractArchived("unknown-id" as unknown as ContractId<TestPayload>);
      expect(callback).not.toHaveBeenCalled();
    });

    it("removes firstSeenAt entry", async () => {
      const event = createMockCreateEvent("cid-1", { owner: "Alice", value: 10 });
      await tracker.handleContractCreated(event);
      await tracker.handleContractArchived(event.contractId);

      expect(tracker.getAllContractsWithMeta()).toHaveLength(0);
    });
  });

  describe("getAllContracts / getAllCreateEvents / getAllContractsWithMeta", () => {
    it("getAllContracts returns Map of contractId → payload", async () => {
      await tracker.handleContractCreated(createMockCreateEvent("cid-1", { owner: "A", value: 1 }));
      await tracker.handleContractCreated(createMockCreateEvent("cid-2", { owner: "B", value: 2 }));

      const contracts = tracker.getAllContracts();
      expect(contracts.size).toBe(2);
      expect(contracts.get("cid-1" as unknown as ContractId<TestPayload>)).toEqual({ owner: "A", value: 1 });
    });

    it("getAllCreateEvents returns Map of contractId → CreateEvent", async () => {
      const event = createMockCreateEvent("cid-1", { owner: "A", value: 1 });
      await tracker.handleContractCreated(event);

      const events = tracker.getAllCreateEvents();
      expect(events.size).toBe(1);
      expect(events.get(event.contractId)).toBe(event);
    });

    it("getAllContractsWithMeta returns array with firstSeenAt", async () => {
      await tracker.handleContractCreated(createMockCreateEvent("cid-1", { owner: "A", value: 1 }));

      const meta = tracker.getAllContractsWithMeta();
      expect(meta).toHaveLength(1);
      expect(meta[0]).toHaveProperty("contractId");
      expect(meta[0]).toHaveProperty("payload");
      expect(meta[0]).toHaveProperty("firstSeenAt");
    });
  });

  describe("hasContract", () => {
    it("returns true for existing contract", async () => {
      const event = createMockCreateEvent("cid-1", { owner: "A", value: 1 });
      await tracker.handleContractCreated(event);
      expect(tracker.hasContract(event.contractId)).toBe(true);
    });

    it("returns false for non-existing contract", () => {
      expect(tracker.hasContract("cid-x" as unknown as ContractId<TestPayload>)).toBe(false);
    });
  });

  describe("getTemplateId", () => {
    it("returns the configured templateId", () => {
      expect(tracker.getTemplateId()).toBe(templateId);
    });
  });

  describe("callbacks", () => {
    it("registers and fires created callback", async () => {
      const cb = vi.fn();
      tracker.onCreated("key1", cb);

      await tracker.handleContractCreated(createMockCreateEvent("cid-1", { owner: "A", value: 1 }));
      expect(cb).toHaveBeenCalledOnce();
    });

    it("registers and fires archived callback", async () => {
      const cb = vi.fn();
      tracker.onArchived("key1", cb);

      const event = createMockCreateEvent("cid-1", { owner: "A", value: 1 });
      await tracker.handleContractCreated(event);
      await tracker.handleContractArchived(event.contractId);
      expect(cb).toHaveBeenCalledOnce();
    });

    it("throws on duplicate created callback key", () => {
      tracker.onCreated("dup", vi.fn());
      expect(() => tracker.onCreated("dup", vi.fn())).toThrow("Callback with key dup already exists");
    });

    it("throws on duplicate archived callback key", () => {
      tracker.onArchived("dup", vi.fn());
      expect(() => tracker.onArchived("dup", vi.fn())).toThrow("Callback with key dup already exists");
    });

    it("removes created callback", async () => {
      const cb = vi.fn();
      tracker.onCreated("key1", cb);
      tracker.removeCreatedCallback("key1");

      await tracker.handleContractCreated(createMockCreateEvent("cid-1", { owner: "A", value: 1 }));
      expect(cb).not.toHaveBeenCalled();
    });

    it("removes archived callback", async () => {
      const cb = vi.fn();
      tracker.onArchived("key1", cb);
      tracker.removeArchivedCallback("key1");

      const event = createMockCreateEvent("cid-1", { owner: "A", value: 1 });
      await tracker.handleContractCreated(event);
      await tracker.handleContractArchived(event.contractId);
      expect(cb).not.toHaveBeenCalled();
    });
  });

  describe("cleanup", () => {
    it("clears contracts and callbacks", async () => {
      tracker.onCreated("cb", vi.fn());
      tracker.onArchived("cb", vi.fn());
      await tracker.handleContractCreated(createMockCreateEvent("cid-1", { owner: "A", value: 1 }));

      tracker.cleanup();

      expect(tracker.getContractCount()).toBe(0);
      // After cleanup, registering with same key should not throw
      expect(() => tracker.onCreated("cb", vi.fn())).not.toThrow();
      expect(() => tracker.onArchived("cb", vi.fn())).not.toThrow();
    });
  });
});
