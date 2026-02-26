import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createMockLogger,
  createMockTemplate,
  createMockInterfaceCompanion,
} from "../helpers/mocks.js";

// Use vi.hoisted so these are available inside the hoisted vi.mock() factory
const { mockMultiStream, mockInterfaceMultiStream, mockLedgerInstance, MockLedger } = vi.hoisted(() => {
  const mockMultiStream = {
    onState: vi.fn(),
    onCreate: vi.fn(),
    onArchive: vi.fn(),
    onError: vi.fn(),
    start: vi.fn(),
    close: vi.fn(),
  };

  const mockInterfaceMultiStream = {
    onState: vi.fn(),
    onInterfaceView: vi.fn(),
    onArchive: vi.fn(),
    onError: vi.fn(),
    start: vi.fn(),
    close: vi.fn(),
  };

  const mockLedgerInstance = {
    getTokenUserInfo: vi.fn().mockResolvedValue({
      rights: [
        { type: "canReadAs", party: "Alice" },
        { type: "canActAs", party: "Alice" },
      ],
    }),
    createMultiStream: vi.fn().mockResolvedValue(mockMultiStream),
    createMultiInterfaceStream: vi.fn().mockResolvedValue(mockInterfaceMultiStream),
  };

  // Use a regular function so it can be called with `new`
  const MockLedger = vi.fn(function (this: any) {
    Object.assign(this, mockLedgerInstance);
  });

  return { mockMultiStream, mockInterfaceMultiStream, mockLedgerInstance, MockLedger };
});

vi.mock("@c7-digital/ledger", () => ({
  Ledger: MockLedger,
}));

// Must import AFTER vi.mock
import { ActiveContractsService } from "../../acs/activeContractsService.js";

describe("ActiveContractsService", () => {
  const versionedRegistry = vi.fn() as any;
  let logger: ReturnType<typeof createMockLogger>;
  let acs: ActiveContractsService;

  beforeEach(() => {
    vi.clearAllMocks();
    // Re-wire default return values after clearAllMocks
    mockLedgerInstance.getTokenUserInfo.mockResolvedValue({
      rights: [
        { type: "canReadAs", party: "Alice" },
        { type: "canActAs", party: "Alice" },
      ],
    });
    mockLedgerInstance.createMultiStream.mockResolvedValue(mockMultiStream);
    mockLedgerInstance.createMultiInterfaceStream.mockResolvedValue(mockInterfaceMultiStream);

    logger = createMockLogger();
    acs = new ActiveContractsService({
      ledgerUrl: "http://localhost:7575",
      versionedRegistry,
      logger,
    });
  });

  describe("construction", () => {
    it("creates without logger (uses noOpLogger)", () => {
      const service = new ActiveContractsService({
        versionedRegistry,
      });
      expect(service.getIsInitialized()).toBe(false);
    });

    it("accepts ledgerUrl from options", () => {
      const service = new ActiveContractsService({
        ledgerUrl: "http://custom:8080",
        versionedRegistry,
        logger,
      });
      expect(service.getIsInitialized()).toBe(false);
    });

    it("accepts ledgerUrl via setLedgerUrl", () => {
      const service = new ActiveContractsService({ versionedRegistry, logger });
      service.setLedgerUrl("http://late:9090");
    });
  });

  describe("registerTemplate", () => {
    it("returns a tracker", () => {
      const template = createMockTemplate("pkg:Mod:T1");
      const tracker = acs.registerTemplate(template);
      expect(tracker).toBeDefined();
      expect(tracker.getContractCount()).toBe(0);
    });

    it("throws on duplicate registration", () => {
      const template = createMockTemplate("pkg:Mod:T1");
      acs.registerTemplate(template);
      expect(() => acs.registerTemplate(template)).toThrow("already registered");
    });

    it("throws after initialization", async () => {
      acs.registerTemplate(createMockTemplate("pkg:Mod:T1"));
      await acs.initWithToken("token");

      expect(() => acs.registerTemplate(createMockTemplate("pkg:Mod:T2"))).toThrow(
        "after initialization",
      );
    });

    it("accepts relevanceFn", () => {
      const template = createMockTemplate("pkg:Mod:T1");
      const tracker = acs.registerTemplate(template, (p: any) => p.active === true);
      expect(tracker).toBeDefined();
    });
  });

  describe("registerInterface", () => {
    it("returns a tracker", () => {
      const iface = createMockInterfaceCompanion("pkg:Mod:I1");
      const tracker = acs.registerInterface(iface);
      expect(tracker).toBeDefined();
      expect(tracker.getInterfaceCount()).toBe(0);
    });

    it("throws on duplicate registration", () => {
      const iface = createMockInterfaceCompanion("pkg:Mod:I1");
      acs.registerInterface(iface);
      expect(() => acs.registerInterface(iface)).toThrow("already registered");
    });

    it("throws after initialization", async () => {
      acs.registerTemplate(createMockTemplate("pkg:Mod:T1"));
      await acs.initWithToken("token");

      expect(() => acs.registerInterface(createMockInterfaceCompanion("pkg:Mod:I1"))).toThrow(
        "after initialization",
      );
    });
  });

  describe("getTracker / getInterfaceTracker", () => {
    it("returns registered template tracker", () => {
      const template = createMockTemplate("pkg:Mod:T1");
      const registered = acs.registerTemplate(template);
      expect(acs.getTracker(template)).toBe(registered);
    });

    it("throws for unregistered template", () => {
      const template = createMockTemplate("pkg:Mod:Unknown");
      expect(() => acs.getTracker(template)).toThrow("not registered");
    });

    it("returns registered interface tracker", () => {
      const iface = createMockInterfaceCompanion("pkg:Mod:I1");
      const registered = acs.registerInterface(iface);
      expect(acs.getInterfaceTracker(iface)).toBe(registered);
    });

    it("throws for unregistered interface", () => {
      const iface = createMockInterfaceCompanion("pkg:Mod:Unknown");
      expect(() => acs.getInterfaceTracker(iface)).toThrow("not registered");
    });
  });

  describe("initWithToken", () => {
    it("creates a Ledger with correct options", async () => {
      acs.registerTemplate(createMockTemplate("pkg:Mod:T1"));
      await acs.initWithToken("my-token");

      expect(MockLedger).toHaveBeenCalledWith(
        expect.objectContaining({
          token: "my-token",
          httpBaseUrl: "http://localhost:7575",
          validation: "logErrors",
          versionedRegistry,
        }),
      );
    });

    it("strips trailing slash from ledgerUrl", async () => {
      const service = new ActiveContractsService({
        ledgerUrl: "http://localhost:7575/",
        versionedRegistry,
        logger,
      });
      service.registerTemplate(createMockTemplate("pkg:Mod:T1"));
      await service.initWithToken("token");

      expect(MockLedger).toHaveBeenCalledWith(
        expect.objectContaining({
          httpBaseUrl: "http://localhost:7575",
        }),
      );
    });

    it("fetches user info", async () => {
      acs.registerTemplate(createMockTemplate("pkg:Mod:T1"));
      await acs.initWithToken("token");

      expect(mockLedgerInstance.getTokenUserInfo).toHaveBeenCalled();
    });

    it("starts MultiStream", async () => {
      acs.registerTemplate(createMockTemplate("pkg:Mod:T1"));
      await acs.initWithToken("token");

      expect(mockLedgerInstance.createMultiStream).toHaveBeenCalled();
      expect(mockMultiStream.start).toHaveBeenCalled();
    });

    it("throws without ledgerUrl", async () => {
      const service = new ActiveContractsService({ versionedRegistry, logger });
      await expect(service.initWithToken("token")).rejects.toThrow(
        "Ledger URL must be set before initializing",
      );
    });

    it("sets isInitialized to true", async () => {
      acs.registerTemplate(createMockTemplate("pkg:Mod:T1"));
      expect(acs.getIsInitialized()).toBe(false);
      await acs.initWithToken("token");
      expect(acs.getIsInitialized()).toBe(true);
    });

    it("cleans up on re-init", async () => {
      acs.registerTemplate(createMockTemplate("pkg:Mod:T1"));
      await acs.initWithToken("token1");

      await acs.initWithToken("token2");
      // First multiStream should have been closed during cleanup
      expect(mockMultiStream.close).toHaveBeenCalled();
    });
  });

  describe("InterfaceMultiStream", () => {
    it("initializes when interfaces are registered", async () => {
      acs.registerTemplate(createMockTemplate("pkg:Mod:T1"));
      acs.registerInterface(createMockInterfaceCompanion("pkg:Mod:I1"));
      await acs.initWithToken("token");

      expect(mockLedgerInstance.createMultiInterfaceStream).toHaveBeenCalled();
      expect(mockInterfaceMultiStream.start).toHaveBeenCalled();
    });

    it("skips when no interfaces are registered", async () => {
      acs.registerTemplate(createMockTemplate("pkg:Mod:T1"));
      await acs.initWithToken("token");

      expect(mockLedgerInstance.createMultiInterfaceStream).not.toHaveBeenCalled();
    });
  });

  describe("convenience methods", () => {
    it("getPayload delegates to tracker", () => {
      const template = createMockTemplate("pkg:Mod:T1");
      acs.registerTemplate(template);
      expect(acs.getPayload(template, "cid-x" as any)).toBeUndefined();
    });

    it("getAllPayloads delegates to tracker", () => {
      const template = createMockTemplate("pkg:Mod:T1");
      acs.registerTemplate(template);
      const result = acs.getAllPayloads(template);
      expect(result).toBeInstanceOf(Map);
      expect(result!.size).toBe(0);
    });

    it("getContractCount delegates to tracker", () => {
      const template = createMockTemplate("pkg:Mod:T1");
      acs.registerTemplate(template);
      expect(acs.getContractCount(template)).toBe(0);
    });

    it("getAllCreateEvents delegates to tracker", () => {
      const template = createMockTemplate("pkg:Mod:T1");
      acs.registerTemplate(template);
      const result = acs.getAllCreateEvents(template);
      expect(result).toBeInstanceOf(Map);
    });

    it("getRegisteredContractTypes returns template IDs", () => {
      acs.registerTemplate(createMockTemplate("pkg:Mod:T1"));
      acs.registerTemplate(createMockTemplate("pkg:Mod:T2"));
      const types = acs.getRegisteredContractTypes();
      expect(types).toContain("pkg:Mod:T1");
      expect(types).toContain("pkg:Mod:T2");
    });

    it("getInterfaceView delegates to tracker", () => {
      const iface = createMockInterfaceCompanion("pkg:Mod:I1");
      acs.registerInterface(iface);
      expect(acs.getInterfaceView(iface, "cid-x" as any)).toBeUndefined();
    });

    it("getAllInterfaceViews delegates to tracker", () => {
      const iface = createMockInterfaceCompanion("pkg:Mod:I1");
      acs.registerInterface(iface);
      const result = acs.getAllInterfaceViews(iface);
      expect(result).toBeInstanceOf(Map);
    });

    it("getInterfaceCount delegates to tracker", () => {
      const iface = createMockInterfaceCompanion("pkg:Mod:I1");
      acs.registerInterface(iface);
      expect(acs.getInterfaceCount(iface)).toBe(0);
    });

    it("getAllInterfaceEvents delegates to tracker", () => {
      const iface = createMockInterfaceCompanion("pkg:Mod:I1");
      acs.registerInterface(iface);
      const result = acs.getAllInterfaceEvents(iface);
      expect(result).toBeInstanceOf(Map);
    });

    it("getRegisteredInterfaceTypes returns interface IDs", () => {
      acs.registerInterface(createMockInterfaceCompanion("pkg:Mod:I1"));
      acs.registerInterface(createMockInterfaceCompanion("pkg:Mod:I2"));
      const types = acs.getRegisteredInterfaceTypes();
      expect(types).toContain("pkg:Mod:I1");
      expect(types).toContain("pkg:Mod:I2");
    });
  });

  describe("stream GC management", () => {
    it("addStreamReference / removeStreamReference", () => {
      const mockStream = { close: vi.fn() } as any;
      acs.addStreamReference(mockStream);
      acs.removeStreamReference(mockStream);
      expect(logger.debug).toHaveBeenCalled();
    });

    it("removeStreamReference is no-op for unknown stream", () => {
      const mockStream = { close: vi.fn() } as any;
      acs.removeStreamReference(mockStream);
    });
  });

  describe("cleanupStream", () => {
    it("closes all streams and resets state", async () => {
      acs.registerTemplate(createMockTemplate("pkg:Mod:T1"));
      await acs.initWithToken("token");
      expect(acs.getIsInitialized()).toBe(true);

      await acs.cleanupStream();
      expect(acs.getIsInitialized()).toBe(false);
      expect(acs.getLedger()).toBeUndefined();
    });

    it("closes individually tracked streams", async () => {
      const mockStream = { close: vi.fn() } as any;
      acs.addStreamReference(mockStream);

      await acs.cleanupStream();
      expect(mockStream.close).toHaveBeenCalled();
    });

    it("preserves tracker contract data", async () => {
      const template = createMockTemplate("pkg:Mod:T1");
      const tracker = acs.registerTemplate(template);
      const { createMockCreateEvent } = await import("../helpers/mocks.js");
      await tracker.handleContractCreated(
        createMockCreateEvent("cid-1", { test: true }),
      );

      await acs.cleanupStream();

      expect(tracker.getContractCount()).toBe(1);
    });

    it("handles cleanup when streams throw on close", async () => {
      const badStream = {
        close: vi.fn().mockImplementation(() => {
          throw new Error("close failed");
        }),
      } as any;
      acs.addStreamReference(badStream);

      await expect(acs.cleanupStream()).resolves.not.toThrow();
    });
  });
});
