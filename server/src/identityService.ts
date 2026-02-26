import Keycloak, { KeycloakConfig as KeycloakConnectConfig } from "keycloak-connect";
import { decodeJwt } from "jose";
import type { KeycloakConfig, TokenUpdateCallback } from "./types.js";
import type { Logger } from "./logger.js";
import { sha256 } from "./sha256.js";

interface KeycloakConfigWithCredentials extends KeycloakConnectConfig {
  credentials: {
    secret: string;
  };
}

function hiddenKeycloakConfig(config: KeycloakConfigWithCredentials): KeycloakConfigWithCredentials {
  const {
    credentials: { secret },
    ...restConfig
  } = config;
  const hashSecret = sha256(secret);
  const encodedCredentials = { credentials: { secret: hashSecret } };
  return { ...restConfig, ...encodedCredentials };
}

export class IdentityService {
  private keycloak: Keycloak.Keycloak | null = null;
  private keycloakConnectConfig: KeycloakConnectConfig | null = null;
  private tokenRefreshTimer: NodeJS.Timeout | null = null;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private nextRefreshTime: number | null = null;
  private tokenUpdateCallbacks: Map<string, TokenUpdateCallback> = new Map();
  private logger: Logger;
  private keycloakConfig: KeycloakConfig;

  // Internalized token state (replaces appState.ts)
  private token: string | null = null;
  private tokenExpiresIn: number = 0;

  public isInitialized = false;

  constructor(config: KeycloakConfig, logger: Logger) {
    this.keycloakConfig = config;
    this.logger = logger;
  }

  /**
   * Get the current token
   */
  getToken(): string | null {
    return this.token;
  }

  /**
   * Get the current token expiration time in seconds
   */
  getTokenExpiresIn(): number {
    return this.tokenExpiresIn;
  }

  /**
   * Initialize with a static ledger token, bypassing Keycloak.
   * Used for LocalNet testing where the token comes from Canton console.
   */
  async initWithStaticToken(staticToken: string): Promise<void> {
    this.logger.info("Initializing Identity Service with static ledger token (Keycloak bypassed)");
    this.token = staticToken;

    const decoded = decodeJwt(staticToken);
    const expiresIn = decoded.exp ? Math.floor(decoded.exp - Date.now() / 1000) : 3600;
    this.tokenExpiresIn = expiresIn;

    // Notify all registered callbacks (e.g., activeContractsService)
    for (const [serviceId, callback] of this.tokenUpdateCallbacks.entries()) {
      try {
        await callback(staticToken);
      } catch (error) {
        this.logger.error(`Error in token update callback for ${serviceId}:`, error as Error);
      }
    }

    this.isInitialized = true;
    this.logger.warn(`Static token expires in ${expiresIn}s. Token will NOT auto-refresh. Re-run 'just local::init' for a fresh token.`);
  }

  /**
   * Initialize the service and fetch the initial token
   */
  async init(): Promise<void> {
    try {
      this.keycloakConnectConfig = {
        realm: this.keycloakConfig.realm,
        "auth-server-url": this.keycloakConfig.url,
        "ssl-required": "external",
        resource: this.keycloakConfig.clientId,
        "confidential-port": 0,
        credentials: {
          secret: this.keycloakConfig.clientSecret,
        },
      } as KeycloakConfigWithCredentials;

      this.logger.debug("Keycloak config:", hiddenKeycloakConfig(this.keycloakConnectConfig as KeycloakConfigWithCredentials));
      this.keycloak = new Keycloak({ store: {} }, this.keycloakConnectConfig);

      this.logger.info("Initializing Identity Service...");
      await this.fetchToken();
      this.isInitialized = true;
    } catch (error) {
      this.logger.error("Failed to initialize Identity Service:", error as Error);
      throw error;
    }
  }

  /**
   * Register a callback to be called when the token is updated
   */
  onTokenUpdate(serviceId: string, callback: TokenUpdateCallback): void {
    this.tokenUpdateCallbacks.set(serviceId, callback);
  }

  /**
   * Remove a token update callback for a specific service
   */
  removeTokenUpdateCallback(serviceId: string): boolean {
    return this.tokenUpdateCallbacks.delete(serviceId);
  }

  /**
   * Get current number of registered token update callbacks
   */
  getCallbackCount(): number {
    return this.tokenUpdateCallbacks.size;
  }

  /**
   * Get current configuration
   */
  getConfig() {
    return {
      url: this.keycloakConfig.url,
      realm: this.keycloakConfig.realm,
      clientId: this.keycloakConfig.clientId,
    };
  }

  /**
   * Get current status including next token refresh time
   */
  getStatus() {
    return {
      isInitialized: this.isInitialized,
      nextRefreshTime: this.nextRefreshTime,
      hasHeartbeat: this.heartbeatInterval !== null,
      callbackCount: this.tokenUpdateCallbacks.size,
      tokenExpiresIn: this.tokenExpiresIn,
    };
  }

  /**
   * Destroy the service and clean up resources
   */
  async destroy(): Promise<void> {
    this.logger.info("Destroying Identity Service...");

    this.stopHeartbeat();

    if (this.tokenRefreshTimer) {
      clearTimeout(this.tokenRefreshTimer);
      this.tokenRefreshTimer = null;
    }

    this.nextRefreshTime = null;
    this.token = "";
    this.tokenExpiresIn = 0;
    this.isInitialized = false;
    this.keycloak = null;
    this.keycloakConnectConfig = null;

    this.logger.info("Identity Service destroyed");
  }

  /**
   * Fetch a new token from Keycloak using Client Credentials (Service Account) flow
   */
  private async fetchToken(retries: number = 3, isScheduledRefresh: boolean = false): Promise<void> {
    this.isInitialized = false;

    const attemptFetch = async (attempt: number): Promise<void> => {
      try {
        if (!this.keycloak) {
          this.logger.error("Keycloak not initialized");
          return;
        }

        this.logger.debug(`Attempting to fetch token (attempt ${attempt}/${retries})`);

        const grant = await this.keycloak.grantManager.obtainFromClientCredentials();

        if (!grant || !grant.access_token) {
          throw new Error("Failed to obtain token from Keycloak");
        }

        if (grant.isExpired()) {
          if (attempt < retries) {
            this.logger.info(`Token is expired, retrying (${retries - attempt} attempts remaining)...`);
            await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
            return attemptFetch(attempt + 1);
          } else {
            throw new Error("Token is expired after all retries");
          }
        }

        const accessToken = grant.access_token;
        const newToken = (accessToken as any).token as string;
        this.logger.debug(`New token:`, { token: newToken, payload: decodeJwt(newToken) });

        this.tokenExpiresIn = parseInt(grant.expires_in ?? "0");

        if (this.token !== newToken) {
          this.token = newToken;

          for (const [serviceId, callback] of this.tokenUpdateCallbacks.entries()) {
            try {
              await callback(newToken);
            } catch (error) {
              this.logger.error(
                `Error in token update callback for service ${serviceId}:`,
                error as Error
              );
            }
          }

          this.scheduleTokenRefresh(this.tokenExpiresIn);
          this.logger.info("Successfully obtained Keycloak token");
        } else {
          this.logger.info("Same token, skipping update");
        }
        this.isInitialized = true;
      } catch (error) {
        this.logger.error(`Error fetching Keycloak token (attempt ${attempt}/${retries}):`, error as Error);

        if (attempt < retries) {
          const delay = Math.min(1000 * Math.pow(2, attempt), 5000);
          this.logger.info(`Retrying token fetch in ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          return attemptFetch(attempt + 1);
        } else {
          if (isScheduledRefresh) {
            this.logger.warn("Scheduled token refresh failed after all retries, will retry in 30 seconds");
            this.scheduleTokenRefresh(30);
          } else {
            throw error;
          }
        }
      }
    };

    await attemptFetch(1);
  }

  private scheduleTokenRefresh(expiresInSeconds: number): void {
    if (this.tokenRefreshTimer) {
      clearTimeout(this.tokenRefreshTimer);
    }

    const refreshInMs = Math.min((expiresInSeconds - 60) * 1000, (expiresInSeconds * 1000) / 2);
    const safeRefreshMs = Math.max(refreshInMs, (expiresInSeconds - 30) * 1000);
    const finalRefreshMs = Math.max(safeRefreshMs, 1000);

    this.nextRefreshTime = Date.now() + finalRefreshMs;

    this.logger.info(`Scheduling token refresh in ${finalRefreshMs / 1000} seconds (at ${new Date(this.nextRefreshTime).toISOString()})`);

    this.tokenRefreshTimer = setTimeout(async () => {
      this.nextRefreshTime = null;
      await this.fetchToken(3, true);
    }, finalRefreshMs);

    this.startHeartbeat();
  }

  private startHeartbeat(): void {
    if (this.heartbeatInterval) {
      return;
    }

    this.heartbeatInterval = setInterval(() => {
      if (this.nextRefreshTime && Date.now() >= this.nextRefreshTime) {
        this.logger.warn(`Missed scheduled token refresh! Triggering now. Was scheduled for ${new Date(this.nextRefreshTime).toISOString()}`);
        this.nextRefreshTime = null;

        if (this.tokenRefreshTimer) {
          clearTimeout(this.tokenRefreshTimer);
          this.tokenRefreshTimer = null;
        }

        this.fetchToken(3, true).catch(err => {
          this.logger.error("Heartbeat-triggered token refresh failed:", err);
        });
      }
    }, 30000);

    this.logger.debug("Token refresh heartbeat monitor started");
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
      this.logger.debug("Token refresh heartbeat monitor stopped");
    }
  }
}
