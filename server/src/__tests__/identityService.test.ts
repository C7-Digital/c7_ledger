import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { KeycloakConfig } from "../types.js";
import type { Logger } from "../logger.js";

function createMockAppLogger(): Logger & {
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
  } as any;
}

// Use vi.hoisted for mock state that needs to be accessible inside vi.mock() factories
const { mockGrantManager, mockDecodeJwt } = vi.hoisted(() => {
  const mockGrantManager = {
    obtainFromClientCredentials: vi.fn(),
  };
  const mockDecodeJwt = vi.fn();
  return { mockGrantManager, mockDecodeJwt };
});

vi.mock("jose", () => ({
  decodeJwt: mockDecodeJwt,
}));

vi.mock("keycloak-connect", () => {
  return {
    default: vi.fn(function (this: any) {
      this.grantManager = mockGrantManager;
    }),
  };
});

// Import after mocks
import { IdentityService } from "../identityService.js";

describe("IdentityService", () => {
  const keycloakConfig: KeycloakConfig = {
    url: "http://keycloak:8080",
    realm: "test-realm",
    clientId: "test-client",
    clientSecret: "test-secret",
  };
  let logger: ReturnType<typeof createMockAppLogger>;
  let service: IdentityService;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    logger = createMockAppLogger();
    service = new IdentityService(keycloakConfig, logger);
  });

  afterEach(async () => {
    await service.destroy();
    vi.useRealTimers();
  });

  describe("constructor", () => {
    it("stores config and starts uninitialized", () => {
      expect(service.isInitialized).toBe(false);
      expect(service.getToken()).toBeNull();
      expect(service.getTokenExpiresIn()).toBe(0);
    });
  });

  describe("initWithStaticToken", () => {
    it("sets token", async () => {
      mockDecodeJwt.mockReturnValue({ exp: Date.now() / 1000 + 3600 });

      await service.initWithStaticToken("static-jwt-token");
      expect(service.getToken()).toBe("static-jwt-token");
    });

    it("decodes JWT for expiry", async () => {
      const futureExp = Date.now() / 1000 + 7200;
      mockDecodeJwt.mockReturnValue({ exp: futureExp });

      await service.initWithStaticToken("static-jwt");
      expect(mockDecodeJwt).toHaveBeenCalledWith("static-jwt");
      expect(service.getTokenExpiresIn()).toBeGreaterThan(0);
    });

    it("sets isInitialized", async () => {
      mockDecodeJwt.mockReturnValue({ exp: Date.now() / 1000 + 3600 });

      await service.initWithStaticToken("token");
      expect(service.isInitialized).toBe(true);
    });

    it("notifies registered callbacks", async () => {
      mockDecodeJwt.mockReturnValue({ exp: Date.now() / 1000 + 3600 });

      const callback = vi.fn().mockResolvedValue(undefined);
      service.onTokenUpdate("test-service", callback);

      await service.initWithStaticToken("new-token");
      expect(callback).toHaveBeenCalledWith("new-token");
    });

    it("handles callback errors gracefully", async () => {
      mockDecodeJwt.mockReturnValue({ exp: Date.now() / 1000 + 3600 });

      service.onTokenUpdate("bad-service", async () => {
        throw new Error("callback failed");
      });

      await expect(service.initWithStaticToken("token")).resolves.not.toThrow();
      expect(logger.error).toHaveBeenCalled();
    });

    it("defaults expiry to 3600 when no exp claim", async () => {
      mockDecodeJwt.mockReturnValue({}); // no exp

      await service.initWithStaticToken("no-exp-token");
      expect(service.getTokenExpiresIn()).toBe(3600);
    });
  });

  describe("init (Keycloak)", () => {
    it("creates Keycloak with correct config", async () => {
      const Keycloak = (await import("keycloak-connect")).default;
      const newToken = "keycloak-jwt-token";

      mockGrantManager.obtainFromClientCredentials.mockResolvedValue({
        access_token: { token: newToken },
        isExpired: () => false,
        expires_in: "300",
      });
      mockDecodeJwt.mockReturnValue({ exp: Date.now() / 1000 + 300 });

      await service.init();

      expect(Keycloak).toHaveBeenCalledWith(
        { store: {} },
        expect.objectContaining({
          realm: "test-realm",
          "auth-server-url": "http://keycloak:8080",
          resource: "test-client",
        }),
      );
    });

    it("fetches token and sets isInitialized", async () => {
      const newToken = "keycloak-jwt-token";
      mockGrantManager.obtainFromClientCredentials.mockResolvedValue({
        access_token: { token: newToken },
        isExpired: () => false,
        expires_in: "300",
      });
      mockDecodeJwt.mockReturnValue({ exp: Date.now() / 1000 + 300 });

      await service.init();
      expect(service.isInitialized).toBe(true);
      expect(service.getToken()).toBe(newToken);
    });

    it("throws on failure", async () => {
      mockGrantManager.obtainFromClientCredentials.mockRejectedValue(
        new Error("Keycloak unreachable"),
      );

      // Attach rejection handler BEFORE advancing timers to avoid unhandled rejection
      const assertion = expect(service.init()).rejects.toThrow("Keycloak unreachable");
      // Advance past retry backoff delays (2s + 4s + 5s cap)
      await vi.advanceTimersByTimeAsync(15000);
      await assertion;
    });
  });

  describe("getToken / getTokenExpiresIn / getConfig / getStatus", () => {
    it("returns null token before init", () => {
      expect(service.getToken()).toBeNull();
    });

    it("returns 0 tokenExpiresIn before init", () => {
      expect(service.getTokenExpiresIn()).toBe(0);
    });

    it("returns config without secret", () => {
      const config = service.getConfig();
      expect(config).toEqual({
        url: "http://keycloak:8080",
        realm: "test-realm",
        clientId: "test-client",
      });
      expect((config as any).clientSecret).toBeUndefined();
    });

    it("returns status before init", () => {
      const status = service.getStatus();
      expect(status.isInitialized).toBe(false);
      expect(status.nextRefreshTime).toBeNull();
      expect(status.hasHeartbeat).toBe(false);
      expect(status.callbackCount).toBe(0);
      expect(status.tokenExpiresIn).toBe(0);
    });

    it("returns correct values after static init", async () => {
      mockDecodeJwt.mockReturnValue({ exp: Date.now() / 1000 + 3600 });

      await service.initWithStaticToken("my-token");

      expect(service.getToken()).toBe("my-token");
      expect(service.getTokenExpiresIn()).toBeGreaterThan(0);
      expect(service.getStatus().isInitialized).toBe(true);
    });
  });

  describe("token callbacks", () => {
    it("registers a callback", () => {
      service.onTokenUpdate("svc1", vi.fn());
      expect(service.getCallbackCount()).toBe(1);
    });

    it("removes a callback", () => {
      service.onTokenUpdate("svc1", vi.fn());
      const removed = service.removeTokenUpdateCallback("svc1");
      expect(removed).toBe(true);
      expect(service.getCallbackCount()).toBe(0);
    });

    it("removeTokenUpdateCallback returns false for unknown", () => {
      expect(service.removeTokenUpdateCallback("unknown")).toBe(false);
    });

    it("reports correct callback count", () => {
      service.onTokenUpdate("svc1", vi.fn());
      service.onTokenUpdate("svc2", vi.fn());
      service.onTokenUpdate("svc3", vi.fn());
      expect(service.getCallbackCount()).toBe(3);
    });

    it("callback is called on token change via init", async () => {
      const callback = vi.fn().mockResolvedValue(undefined);
      service.onTokenUpdate("svc1", callback);

      const newToken = "new-kc-token";
      mockGrantManager.obtainFromClientCredentials.mockResolvedValue({
        access_token: { token: newToken },
        isExpired: () => false,
        expires_in: "300",
      });
      mockDecodeJwt.mockReturnValue({ exp: Date.now() / 1000 + 300 });

      await service.init();
      expect(callback).toHaveBeenCalledWith(newToken);
    });

    it("callback is NOT called when same token", async () => {
      const theToken = "same-token";
      mockGrantManager.obtainFromClientCredentials.mockResolvedValue({
        access_token: { token: theToken },
        isExpired: () => false,
        expires_in: "300",
      });
      mockDecodeJwt.mockReturnValue({ exp: Date.now() / 1000 + 300 });

      await service.init();

      // Register callback after init
      const callback = vi.fn().mockResolvedValue(undefined);
      service.onTokenUpdate("late-svc", callback);

      // Advance past the refresh timer (~270s for 300s expiry)
      // Uses advanceTimersByTimeAsync to avoid infinite loop with heartbeat
      await vi.advanceTimersByTimeAsync(280000);

      // The callback should NOT have been called because the token didn't change
      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe("token refresh scheduling", () => {
    it("schedules refresh before expiry", async () => {
      mockGrantManager.obtainFromClientCredentials.mockResolvedValue({
        access_token: { token: "refresh-token" },
        isExpired: () => false,
        expires_in: "300",
      });
      mockDecodeJwt.mockReturnValue({ exp: Date.now() / 1000 + 300 });

      await service.init();

      const status = service.getStatus();
      expect(status.nextRefreshTime).not.toBeNull();
      expect(status.nextRefreshTime!).toBeGreaterThan(Date.now());
    });

    it("rescheduling clears previous timer", async () => {
      mockGrantManager.obtainFromClientCredentials
        .mockResolvedValueOnce({
          access_token: { token: "token-1" },
          isExpired: () => false,
          expires_in: "300",
        })
        .mockResolvedValue({
          access_token: { token: "token-2" },
          isExpired: () => false,
          expires_in: "600",
        });
      mockDecodeJwt.mockReturnValue({ exp: Date.now() / 1000 + 600 });

      await service.init();
      const firstRefreshTime = service.getStatus().nextRefreshTime;

      // Advance past the first refresh timer (~270s for 300s expiry)
      await vi.advanceTimersByTimeAsync(280000);

      const secondRefreshTime = service.getStatus().nextRefreshTime;
      expect(secondRefreshTime).not.toBe(firstRefreshTime);
    });

    it("scheduled failure retries in 30s", async () => {
      mockGrantManager.obtainFromClientCredentials.mockResolvedValueOnce({
        access_token: { token: "initial-token" },
        isExpired: () => false,
        expires_in: "60",
      });
      mockDecodeJwt.mockReturnValue({ exp: Date.now() / 1000 + 60 });

      await service.init();

      // Make subsequent calls fail
      mockGrantManager.obtainFromClientCredentials.mockRejectedValue(new Error("fail"));

      // Advance past the refresh timer (~30s for 60s expiry) plus retry backoff delays
      // Refresh fires at ~30s, then 3 retries with delays 2s+4s ≈ 36s total
      // Stop before the re-scheduled 1s timer cascades further
      await vi.advanceTimersByTimeAsync(40000);

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("will retry in 30 seconds"),
      );
    });
  });

  describe("heartbeat", () => {
    it("starts 30s interval after init", async () => {
      mockGrantManager.obtainFromClientCredentials.mockResolvedValue({
        access_token: { token: "hb-token" },
        isExpired: () => false,
        expires_in: "300",
      });
      mockDecodeJwt.mockReturnValue({ exp: Date.now() / 1000 + 300 });

      await service.init();

      expect(service.getStatus().hasHeartbeat).toBe(true);
    });

    it("no duplicate intervals on repeated init", async () => {
      mockGrantManager.obtainFromClientCredentials.mockResolvedValue({
        access_token: { token: "hb-token" },
        isExpired: () => false,
        expires_in: "300",
      });
      mockDecodeJwt.mockReturnValue({ exp: Date.now() / 1000 + 300 });

      await service.init();
      expect(service.getStatus().hasHeartbeat).toBe(true);
    });
  });

  describe("destroy", () => {
    it("clears timers and resets state", async () => {
      mockGrantManager.obtainFromClientCredentials.mockResolvedValue({
        access_token: { token: "destroy-token" },
        isExpired: () => false,
        expires_in: "300",
      });
      mockDecodeJwt.mockReturnValue({ exp: Date.now() / 1000 + 300 });

      await service.init();
      expect(service.isInitialized).toBe(true);

      await service.destroy();

      expect(service.isInitialized).toBe(false);
      expect(service.getToken()).toBe("");
      expect(service.getTokenExpiresIn()).toBe(0);
      expect(service.getStatus().hasHeartbeat).toBe(false);
      expect(service.getStatus().nextRefreshTime).toBeNull();
    });

    it("is safe to call without init", async () => {
      await expect(service.destroy()).resolves.not.toThrow();
    });
  });
});
