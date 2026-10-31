/**
 * Property tests for TokenRefresher. fast-check generates sources, hooks and
 * caller actions that a caller outside this repository can give, and after
 * each action the test checks the invariants below. A failure prints the
 * smallest scenario that breaks an invariant.
 */
import fc from "fast-check";

import { ConsoleLogger, NoOpLogger, setLogger } from "./logger";
import {
  TokenRefresher,
  type MintedToken,
  type TokenRefresherStatus,
  type TokenSource,
} from "./tokenRefresher";

// The real setImmediate, kept before the tests install fake timers. Node
// reports an unhandled rejection only after the microtask queue is empty.
const realSetImmediate = globalThis.setImmediate;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const DAY_MS = 24 * 3600 * 1000;

/** What one call to `mint()` does. */
type MintBehavior =
  | { kind: "token"; lifetimeMs: number }
  | { kind: "syncThrow" }
  | { kind: "reject" }
  | { kind: "held" };

/** What one call to a hook does. */
type HookBehavior = "return" | "throw" | "reject";

type Action =
  | { kind: "advance"; ms: number }
  | { kind: "refreshNow" }
  | { kind: "start" }
  | { kind: "stop" }
  | { kind: "settle"; outcome: "token" | "reject"; lifetimeMs: number };

const lifetimeMs = fc.oneof(
  fc.integer({ min: -60_000, max: 5_000 }),
  fc.integer({ min: 5_000, max: DAY_MS }),
  fc.integer({ min: DAY_MS, max: 400 * DAY_MS }),
);

const mintBehavior: fc.Arbitrary<MintBehavior> = fc.oneof(
  { weight: 4, arbitrary: lifetimeMs.map((ms) => ({ kind: "token" as const, lifetimeMs: ms })) },
  { weight: 1, arbitrary: fc.constant({ kind: "syncThrow" as const }) },
  { weight: 1, arbitrary: fc.constant({ kind: "reject" as const }) },
  { weight: 1, arbitrary: fc.constant({ kind: "held" as const }) },
);

const hookBehavior: fc.Arbitrary<HookBehavior> = fc.constantFrom(
  "return",
  "throw",
  "reject",
);

const action: fc.Arbitrary<Action> = fc.oneof(
  {
    weight: 6,
    arbitrary: fc.oneof(
      fc.integer({ min: 0, max: 70_000 }),
      fc.integer({ min: 70_000, max: 2 * DAY_MS }),
    ).map((ms) => ({ kind: "advance" as const, ms })),
  },
  { weight: 2, arbitrary: fc.constant({ kind: "refreshNow" as const }) },
  { weight: 1, arbitrary: fc.constant({ kind: "start" as const }) },
  { weight: 1, arbitrary: fc.constant({ kind: "stop" as const }) },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant("settle" as const),
      outcome: fc.constantFrom("token" as const, "reject" as const),
      lifetimeMs,
    }),
  },
);

const scenario = fc.record({
  mints: fc.array(mintBehavior, { maxLength: 30 }),
  onToken: fc.array(hookBehavior, { maxLength: 10 }),
  onFailure: fc.array(hookBehavior, { maxLength: 10 }),
  actions: fc.array(action, { minLength: 1, maxLength: 40 }),
});

/** A source that follows the scripted behaviors, then gives 5-minute tokens. */
function scriptedSource(mints: MintBehavior[]): TokenSource & {
  settle: (outcome: "token" | "reject", lifetimeMs: number) => void;
} {
  let calls = 0;
  const held: Array<{
    resolve: (m: MintedToken) => void;
    reject: (e: Error) => void;
  }> = [];
  return {
    mint: () => {
      calls += 1;
      const behavior = mints[calls - 1] ?? { kind: "token", lifetimeMs: 300_000 };
      switch (behavior.kind) {
        case "syncThrow":
          throw new Error(`mint ${calls} threw`);
        case "reject":
          return Promise.reject(new Error(`mint ${calls} rejected`));
        case "held":
          return new Promise<MintedToken>((resolve, reject) => {
            held.push({ resolve, reject });
          });
        case "token":
          return Promise.resolve({
            token: `token-${calls}`,
            expiresAt: new Date(Date.now() + behavior.lifetimeMs),
          });
      }
    },
    settle: (outcome, ms) => {
      const next = held.shift();
      if (next === undefined) return;
      if (outcome === "token") {
        next.resolve({ token: "held", expiresAt: new Date(Date.now() + ms) });
      } else {
        next.reject(new Error("held mint rejected"));
      }
    },
  };
}

function hook(behaviors: HookBehavior[], record: () => void): () => unknown {
  let calls = 0;
  return () => {
    record();
    const behavior = behaviors[calls] ?? "return";
    calls += 1;
    if (behavior === "throw") throw new Error("hook threw");
    if (behavior === "reject") return Promise.reject(new Error("hook rejected"));
    return undefined;
  };
}

interface Observed {
  status: TokenRefresherStatus;
  timers: number;
  stopped: boolean;
  /** onToken calls after stop(). */
  tokensSinceStop: number;
  /** onFailure calls since the last onToken call. */
  failuresSinceToken: number;
}

/** The names of the invariants that `o` breaks. */
function brokenInvariants(o: Observed): string[] {
  const { status, timers, stopped } = o;
  const now = Date.now();
  const next = status.nextRefreshAt?.getTime() ?? null;
  const expires = status.tokenExpiresAt?.getTime() ?? null;
  const invariants: Array<[string, boolean]> = [
    ["at most one timer is armed", timers <= 1],
    ["no timer is armed after stop()", !stopped || timers === 0],
    ["no token is delivered after stop()", o.tokensSinceStop === 0],
    ["nextRefreshAt names the armed timer", (next !== null) === (timers === 1)],
    ["the next refresh is not in the past", next === null || next >= now],
    [
      "the next refresh is within the setTimeout limit",
      next === null || next - now <= MAX_TIMER_DELAY_MS,
    ],
    [
      "after a token, the next refresh comes before it expires",
      status.failures > 0 || next === null || expires === null || next < expires,
    ],
    [
      "failures counts the failed refreshes since the last token",
      stopped || status.failures === o.failuresSinceToken,
    ],
    ["a failure has an error", (status.lastError === null) === (status.failures === 0)],
  ];
  return invariants.filter(([, holds]) => !holds).map(([name]) => name);
}

describe("TokenRefresher invariants", () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };

  beforeEach(() => {
    vi.useFakeTimers();
    setLogger(new NoOpLogger());
    process.on("unhandledRejection", onUnhandled);
  });

  afterEach(() => {
    process.off("unhandledRejection", onUnhandled);
    setLogger(new ConsoleLogger(true));
    vi.useRealTimers();
  });

  it("hold for any source, hooks and caller actions", async () => {
    await fc.assert(
      fc.asyncProperty(scenario, async ({ mints, onToken, onFailure, actions }) => {
        vi.clearAllTimers();
        unhandled.length = 0;
        const source = scriptedSource(mints);
        let tokensSinceStop = 0;
        let failuresSinceToken = 0;
        let stopped = false;
        const refresher = new TokenRefresher({
          source,
          onToken: hook(onToken, () => {
            failuresSinceToken = 0;
            if (stopped) tokensSinceStop += 1;
          }),
          onFailure: hook(onFailure, () => {
            failuresSinceToken += 1;
          }),
        });

        const run = async (a: Action): Promise<void> => {
          switch (a.kind) {
            case "advance":
              await vi.advanceTimersByTimeAsync(a.ms);
              return;
            case "refreshNow":
              refresher.refreshNow().catch(() => {});
              break;
            case "start":
              refresher.start().catch(() => {});
              break;
            case "stop":
              refresher.stop();
              stopped = true;
              break;
            case "settle":
              source.settle(a.outcome, a.lifetimeMs);
              break;
          }
          await vi.advanceTimersByTimeAsync(0);
        };

        refresher.start().catch(() => {});
        await vi.advanceTimersByTimeAsync(0);
        for (const a of [...actions, { kind: "advance" as const, ms: 0 }]) {
          await run(a);
          const broken = brokenInvariants({
            status: refresher.status(),
            timers: vi.getTimerCount(),
            stopped,
            tokensSinceStop,
            failuresSinceToken,
          });
          expect(broken, `broken invariants: ${broken.join("; ")}`).toEqual([]);
        }

        refresher.stop();
        await new Promise((resolve) => realSetImmediate(resolve));
        // No source, hook or caller action leaves a rejection unhandled.
        expect(unhandled, "no rejection is left unhandled").toEqual([]);
      }),
      { numRuns: 300 },
    );
  });
});
