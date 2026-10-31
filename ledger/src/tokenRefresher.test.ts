import {
  DEFAULT_RETRY_BASE_MS,
  DEFAULT_RETRY_MAX_MS,
  TokenRefresher,
  retryDelayMs,
  type MintedToken,
  type RefreshFailure,
  type TokenSource,
} from "./tokenRefresher";

const LIFETIME_MS = 300_000;
const REFRESH_MS = LIFETIME_MS * 0.8;

type Answer = "ok" | "fail";

/** A source that answers each mint with the next answer, then with "ok". */
function scriptedSource(answers: Answer[]): TokenSource & { calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    mint: async () => {
      const answer = answers[calls] ?? "ok";
      calls += 1;
      if (answer === "fail") throw new Error(`mint ${calls} failed`);
      return {
        token: `token-${calls}`,
        expiresAt: new Date(Date.now() + LIFETIME_MS),
      };
    },
  };
}

/**
 * A source that answers the first mint at once. Each later mint waits until
 * the test settles it.
 */
function heldSource(): TokenSource & {
  settle: (answer: Answer) => void;
} {
  let calls = 0;
  let settle: (answer: Answer) => void = () => {};
  return {
    settle: (answer) => settle(answer),
    mint: () => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve({
          token: "token-1",
          expiresAt: new Date(Date.now() + LIFETIME_MS),
        });
      }
      return new Promise<MintedToken>((resolve, reject) => {
        settle = (answer) =>
          answer === "ok"
            ? resolve({
                token: "late",
                expiresAt: new Date(Date.now() + LIFETIME_MS),
              })
            : reject(new Error("late failure"));
      });
    },
  };
}

describe("retryDelayMs", () => {
  it("doubles from the base delay and stops at the maximum", () => {
    expect([1, 2, 3, 4, 5, 10].map((n) => retryDelayMs(n))).toEqual([
      DEFAULT_RETRY_BASE_MS,
      DEFAULT_RETRY_BASE_MS * 2,
      DEFAULT_RETRY_BASE_MS * 4,
      DEFAULT_RETRY_BASE_MS * 8,
      DEFAULT_RETRY_MAX_MS,
      DEFAULT_RETRY_MAX_MS,
    ]);
  });
});

describe("TokenRefresher", () => {
  let refresher: TokenRefresher | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    refresher?.stop();
    refresher = null;
    vi.useRealTimers();
  });

  function make(source: TokenSource): {
    tokens: string[];
    failures: RefreshFailure[];
    refresher: TokenRefresher;
  } {
    const tokens: string[] = [];
    const failures: RefreshFailure[] = [];
    refresher = new TokenRefresher({
      source,
      onToken: (m) => tokens.push(m.token),
      onFailure: (f) => failures.push(f),
    });
    return { tokens, failures, refresher };
  }

  it("refreshes at 80 % of the token lifetime", async () => {
    const source = scriptedSource([]);
    const { tokens, refresher } = make(source);
    await refresher.start();
    expect(tokens).toEqual(["token-1"]);
    expect(refresher.status().nextRefreshAt?.getTime()).toBe(
      Date.now() + REFRESH_MS,
    );

    await vi.advanceTimersByTimeAsync(REFRESH_MS - 1);
    expect(source.calls()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(tokens).toEqual(["token-1", "token-2"]);
  });

  it("retries with backoff until a refresh succeeds, then goes back to the normal interval", async () => {
    const source = scriptedSource(["ok", "fail", "fail", "ok"]);
    const { tokens, failures, refresher } = make(source);
    await refresher.start();

    await vi.advanceTimersByTimeAsync(REFRESH_MS);
    expect(failures.map((f) => f.retryInMs)).toEqual([retryDelayMs(1)]);
    expect(refresher.status()).toMatchObject({
      failures: 1,
      lastError: "mint 2 failed",
    });

    await vi.advanceTimersByTimeAsync(retryDelayMs(1));
    expect(failures.map((f) => f.failures)).toEqual([1, 2]);

    await vi.advanceTimersByTimeAsync(retryDelayMs(2));
    expect(tokens).toEqual(["token-1", "token-4"]);
    expect(refresher.status()).toMatchObject({ failures: 0, lastError: null });
    expect(refresher.status().nextRefreshAt?.getTime()).toBe(
      Date.now() + REFRESH_MS,
    );
  });

  it("keeps retrying through a long outage", async () => {
    const source = scriptedSource(["ok", ...Array<Answer>(20).fill("fail")]);
    const { tokens, refresher } = make(source);
    await refresher.start();
    await vi.advanceTimersByTimeAsync(REFRESH_MS + 20 * DEFAULT_RETRY_MAX_MS);
    expect(source.calls()).toBe(22);
    expect(tokens).toEqual(["token-1", "token-22"]);
  });

  it("throws when the first mint fails, and arms no timer", async () => {
    const { refresher } = make(scriptedSource(["fail"]));
    await expect(refresher.start()).rejects.toThrow("mint 1 failed");
    expect(refresher.status().nextRefreshAt).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("joins a refresh in flight, and arms one retry when it fails", async () => {
    const source = heldSource();
    const { failures, refresher } = make(source);
    await refresher.start();

    const first = refresher.refreshNow();
    const second = refresher.refreshNow();
    source.settle("fail");
    await expect(first).rejects.toThrow("late failure");
    await expect(second).rejects.toThrow("late failure");
    expect(failures).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("does not let a failing onToken stop the schedule", async () => {
    refresher = new TokenRefresher({
      source: scriptedSource([]),
      onToken: () => {
        throw new Error("hook failed");
      },
    });
    await refresher.start();
    expect(refresher.status().nextRefreshAt).not.toBeNull();
  });

  for (const answer of ["ok", "fail"] as const) {
    it(`arms no timer when stop() runs during a refresh that ends ${answer}`, async () => {
      const source = heldSource();
      const { tokens, refresher } = make(source);
      await refresher.start();

      const pending = refresher.refreshNow();
      refresher.stop();
      source.settle(answer);
      await pending.catch(() => {});
      expect(tokens).toEqual(["token-1"]);
      expect(vi.getTimerCount()).toBe(0);
      expect(refresher.status().nextRefreshAt).toBeNull();
    });
  }

  it("can start again after the first mint fails", async () => {
    const { tokens, refresher } = make(scriptedSource(["fail"]));
    await expect(refresher.start()).rejects.toThrow("mint 1 failed");
    await refresher.start();
    expect(tokens).toEqual(["token-2"]);
  });

  it("rejects a second start() while the first one runs", async () => {
    const { refresher } = make(scriptedSource([]));
    const first = refresher.start();
    await expect(refresher.start()).rejects.toThrow("when starting");
    await first;
  });

  it("arms no timer when stop() runs during start()", async () => {
    const { tokens, refresher } = make(scriptedSource([]));
    const starting = refresher.start();
    refresher.stop();
    await starting;
    expect(tokens).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    await expect(refresher.refreshNow()).rejects.toThrow("when stopped");
  });

  it("rejects refreshNow() before start() and after stop()", async () => {
    const { refresher } = make(scriptedSource([]));
    await expect(refresher.refreshNow()).rejects.toThrow("when new");
    await refresher.start();
    refresher.stop();
    await expect(refresher.refreshNow()).rejects.toThrow("when stopped");
  });

  it("limits a very long token lifetime to the longest timer delay", async () => {
    const { refresher } = make({
      mint: async () => ({
        token: "long",
        expiresAt: new Date(Date.now() + 400 * 24 * 3600 * 1000),
      }),
    });
    await refresher.start();
    expect(refresher.status().nextRefreshAt?.getTime()).toBe(
      Date.now() + 2_147_483_647,
    );
  });
});
