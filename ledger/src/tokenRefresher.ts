/**
 * Keeps a service's ledger access token valid: it gets a new token before the
 * current one expires, and after a failure it retries with backoff until a
 * request succeeds.
 */
import { logger } from "./logger";

/** An access token and the time when it stops being valid. */
export interface MintedToken {
  token: string;
  expiresAt: Date;
}

/** Gets a new access token for the ledger. */
export interface TokenSource {
  mint(): Promise<MintedToken>;
}

/** One failed refresh, and when the refresher tries again. */
export interface RefreshFailure {
  error: unknown;
  /** The number of failed refreshes since the last one that succeeded. */
  failures: number;
  retryInMs: number;
}

export interface TokenRefresherStatus {
  lastRefreshAt: Date | null;
  /** When the armed timer fires, or null when no timer is armed. */
  nextRefreshAt: Date | null;
  tokenExpiresAt: Date | null;
  lastError: string | null;
  failures: number;
}

export interface TokenRefresherOptions {
  source: TokenSource;
  /** Receives each new token. An error from it is logged; the schedule does not change. */
  onToken: (minted: MintedToken) => void;
  onFailure?: (failure: RefreshFailure) => void;
  /** The part of the token lifetime after which to refresh. Default 0.8. */
  refreshAtFraction?: number;
  /** The first retry delay. Each later failure doubles it. Default 5 s. */
  retryBaseMs?: number;
  /** The longest retry delay. Default 60 s. */
  retryMaxMs?: number;
}

export const DEFAULT_REFRESH_AT_FRACTION = 0.8;
export const DEFAULT_RETRY_BASE_MS = 5_000;
export const DEFAULT_RETRY_MAX_MS = 60_000;
const MIN_REFRESH_MS = 1_000;
// setTimeout runs a longer delay at once.
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** The delay before the retry that follows `failures` failed refreshes. */
export function retryDelayMs(
  failures: number,
  baseMs: number = DEFAULT_RETRY_BASE_MS,
  maxMs: number = DEFAULT_RETRY_MAX_MS,
): number {
  return Math.min(maxMs, baseMs * 2 ** Math.max(0, failures - 1));
}

type RefresherState = "new" | "starting" | "running" | "stopped";

export class TokenRefresher {
  private state: RefresherState = "new";
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<MintedToken> | null = null;
  private lastRefreshAt: Date | null = null;
  private nextRefreshAt: Date | null = null;
  private tokenExpiresAt: Date | null = null;
  private lastError: string | null = null;
  private failures = 0;

  constructor(private readonly opts: TokenRefresherOptions) {}

  /**
   * Gets the first token and arms the refresh timer. Throws when the first
   * request fails, and then arms no timer: a service without a first token
   * cannot start. The caller can call `start()` again after a failure.
   */
  async start(): Promise<MintedToken> {
    if (this.state !== "new") {
      throw new Error(`TokenRefresher.start() called when ${this.state}`);
    }
    this.state = "starting";
    let minted: MintedToken;
    try {
      minted = await this.opts.source.mint();
    } catch (e) {
      if (this.state === "starting") this.state = "new";
      throw e;
    }
    // stop() ran during the first request.
    if (this.state !== "starting") return minted;
    this.state = "running";
    this.accept(minted);
    return minted;
  }

  /**
   * Gets a new token now, for example after the ledger rejects the current
   * one. A call during a refresh joins that refresh. On failure the retry
   * timer is armed, and the error is thrown to the caller.
   */
  refreshNow(): Promise<MintedToken> {
    if (this.state !== "running") {
      return Promise.reject(
        new Error(`TokenRefresher.refreshNow() called when ${this.state}`),
      );
    }
    return this.refresh();
  }

  /** Stops the refresh. A refresh in flight delivers no token and arms no timer. */
  stop(): void {
    this.state = "stopped";
    this.clearTimer();
  }

  status(): TokenRefresherStatus {
    return {
      lastRefreshAt: this.lastRefreshAt,
      nextRefreshAt: this.nextRefreshAt,
      tokenExpiresAt: this.tokenExpiresAt,
      lastError: this.lastError,
      failures: this.failures,
    };
  }

  private refresh(): Promise<MintedToken> {
    this.inFlight ??= this.opts.source
      .mint()
      .then(
        (minted) => {
          if (this.state === "running") this.accept(minted);
          return minted;
        },
        (error: unknown) => {
          if (this.state === "running") this.reject(error);
          throw error;
        },
      )
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  private accept(minted: MintedToken): void {
    this.lastRefreshAt = new Date();
    this.tokenExpiresAt = minted.expiresAt;
    this.lastError = null;
    this.failures = 0;
    const lifetimeMs = minted.expiresAt.getTime() - Date.now();
    const fraction = this.opts.refreshAtFraction ?? DEFAULT_REFRESH_AT_FRACTION;
    this.arm(Math.max(MIN_REFRESH_MS, lifetimeMs * fraction));
    try {
      this.opts.onToken(minted);
    } catch (e) {
      logger.error("TokenRefresher: onToken failed", e);
    }
  }

  private reject(error: unknown): void {
    this.failures += 1;
    this.lastError = error instanceof Error ? error.message : String(error);
    const retryInMs = retryDelayMs(
      this.failures,
      this.opts.retryBaseMs,
      this.opts.retryMaxMs,
    );
    this.arm(retryInMs);
    try {
      this.opts.onFailure?.({ error, failures: this.failures, retryInMs });
    } catch (e) {
      logger.error("TokenRefresher: onFailure failed", e);
    }
  }

  private arm(delayMs: number): void {
    this.clearTimer();
    const delay = Math.min(delayMs, MAX_TIMER_DELAY_MS);
    this.nextRefreshAt = new Date(Date.now() + delay);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.nextRefreshAt = null;
      // The failure is already recorded and the retry is armed.
      this.refresh().catch(() => {});
    }, delay);
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.nextRefreshAt = null;
  }
}
