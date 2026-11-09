import fc from "fast-check";
import { afterEach, vi } from "vitest";
import { ScanClient } from "./client.js";
import { ScanApiError, ScanProxyAuthError, ScanUnavailableError } from "./error.js";

// A model of the list client: each request asks the ready Scans in their
// given order, then the cooling Scans, the earliest to recover first. It stops
// at the first Scan that answers (a success or an answer status). An
// unavailable Scan cools down for `cooldownMs`; a Scan that answers is ready.

/** What one Scan does with one request. */
type Outcome = "ok" | "answer" | "unavailable" | "network" | "sync-throw";

const outcome = fc.constantFrom<Outcome>("ok", "answer", "unavailable", "network", "sync-throw");

/** One request of the caller: the outcome of each Scan, then a time step. */
interface Step {
  outcomes: Outcome[];
  advanceMs: number;
}

const COOLDOWN_MS = 1_000;

let runCount = 0;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function expectedOrder(scans: readonly string[], cooling: Map<string, number>, now: number): string[] {
  const ready = scans.filter(s => (cooling.get(s) ?? 0) <= now);
  const waiting = scans
    .filter(s => (cooling.get(s) ?? 0) > now)
    .sort((a, b) => cooling.get(a)! - cooling.get(b)!);
  return [...ready, ...waiting];
}

describe("a list of Scans (property)", () => {
  it("asks each Scan at most once per request, in the model's order, and stops at the first answer", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 4 }).chain(n =>
          fc.array(
            fc.record({
              outcomes: fc.array(outcome, { minLength: n, maxLength: n }),
              advanceMs: fc.oneof(fc.constant(0), fc.integer({ min: 0, max: 3 * COOLDOWN_MS })),
            }),
            { minLength: 1, maxLength: 8 },
          ),
        ),
        async (steps: Step[]) => {
          runCount += 1;
          const n = steps[0]!.outcomes.length;
          const scans = Array.from({ length: n }, (_, i) => `https://s${i}-${runCount}.example.com/api/scan`);
          vi.useFakeTimers({ toFake: ["Date"] });
          vi.setSystemTime(new Date("2026-11-07T00:00:00Z"));

          let current: Outcome[] = [];
          const calls: string[] = [];
          vi.stubGlobal("fetch", (input: string) => {
            const base = `${new URL(input).origin}/api/scan`;
            calls.push(base);
            const o = current[scans.indexOf(base)]!;
            if (o === "sync-throw") throw new TypeError("sync failure");
            if (o === "network") return Promise.reject(new TypeError("fetch failed"));
            const status = o === "ok" ? 200 : o === "answer" ? 404 : 503;
            return Promise.resolve(
              new Response(JSON.stringify({ dso_party_id: base }), {
                status,
                headers: { "content-type": "application/json" },
              }),
            );
          });

          const client = new ScanClient({
            baseUrls: [scans[0]!, ...scans.slice(1)],
            cooldownMs: COOLDOWN_MS,
          });
          const cooling = new Map<string, number>();

          for (const step of steps) {
            current = step.outcomes;
            calls.length = 0;
            const now = Date.now();
            const order = expectedOrder(scans, cooling, now);

            const result = await client.getDsoPartyId().then(
              value => ({ kind: "value" as const, value }),
              (error: unknown) => ({ kind: "error" as const, error }),
            );

            // The calls are a prefix of the model order, and no Scan twice.
            expect(calls).toEqual(order.slice(0, calls.length));
            expect(new Set(calls).size).toBe(calls.length);

            const firstAnswer = order.findIndex(s => {
              const o = step.outcomes[scans.indexOf(s)];
              return o === "ok" || o === "answer";
            });
            const failed = firstAnswer === -1 ? order : order.slice(0, firstAnswer);
            for (const s of failed) cooling.set(s, now + COOLDOWN_MS);
            const answering = firstAnswer === -1 ? undefined : order[firstAnswer]!;
            if (answering !== undefined) cooling.delete(answering);

            const expected =
              answering === undefined
                ? { calls: order, result: { unavailable: order } }
                : {
                    calls: order.slice(0, firstAnswer + 1),
                    result:
                      step.outcomes[scans.indexOf(answering)] === "ok"
                        ? { value: { dso_party_id: answering } }
                        : { answer: 404 },
                  };
            const observed = {
              calls: [...calls],
              result:
                result.kind === "value"
                  ? { value: result.value }
                  : result.error instanceof ScanUnavailableError
                    ? { unavailable: result.error.attempts.map(a => a.baseUrl) }
                    : result.error instanceof ScanApiError
                      ? { answer: result.error.status }
                      : { other: String(result.error) },
            };
            expect(observed).toEqual(expected);
            vi.setSystemTime(Date.now() + step.advanceMs);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

// A model of the proxy route: the token, then the proxy (unless it cools
// down), then the Scans. Only an unavailable proxy cools down; a proxy answer
// makes it ready.

type TokenOutcome = "token" | "none" | "throws";
type ProxyOutcome = "ok" | "unauthorized" | "answer" | "unavailable" | "network";
type ScanOutcome = "ok" | "unavailable";

interface ProxyStep {
  token: TokenOutcome;
  proxy: ProxyOutcome;
  scan: ScanOutcome;
  advanceMs: number;
}

describe("the scan proxy (property)", () => {
  it("asks the proxy at most once, only with a token and when it is not cooling, and falls back only when it is unavailable", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            token: fc.constantFrom<TokenOutcome>("token", "token", "none", "throws"),
            proxy: fc.constantFrom<ProxyOutcome>("ok", "unauthorized", "answer", "unavailable", "network"),
            scan: fc.constantFrom<ScanOutcome>("ok", "unavailable"),
            advanceMs: fc.integer({ min: 0, max: 3 * COOLDOWN_MS }),
          }),
          { minLength: 1, maxLength: 10 },
        ),
        async (steps: ProxyStep[]) => {
          runCount += 1;
          const scan = `https://s-${runCount}.example.com/api/scan`;
          const validator = `https://v-${runCount}.example.com/api/validator`;
          vi.useFakeTimers({ toFake: ["Date"] });
          vi.setSystemTime(new Date("2026-11-07T00:00:00Z"));

          let step: ProxyStep = steps[0]!;
          const calls: string[] = [];
          vi.stubGlobal("fetch", (input: string) => {
            const fromProxy = input.startsWith(validator);
            calls.push(fromProxy ? "proxy" : "scan");
            if (fromProxy && step.proxy === "network") return Promise.reject(new TypeError("fetch failed"));
            const code = fromProxy
              ? { ok: 200, unauthorized: 401, answer: 400, unavailable: 503, network: 0 }[step.proxy]
              : step.scan === "ok"
                ? 200
                : 503;
            return Promise.resolve(
              new Response(JSON.stringify({ dso_party_id: fromProxy ? "proxy" : "scan" }), {
                status: code,
                headers: { "content-type": "application/json" },
              }),
            );
          });
          const client = new ScanClient({
            baseUrls: [scan],
            cooldownMs: COOLDOWN_MS,
            validator: {
              baseUrl: validator,
              token: () => {
                if (step.token === "throws") throw new Error("no session");
                return step.token === "token" ? "t" : undefined;
              },
            },
          });
          let proxyCoolingUntil = 0;

          for (const s of steps) {
            step = s;
            calls.length = 0;
            const now = Date.now();
            const result = await client.getDsoPartyId().then(
              value => ({ value: value.dso_party_id }),
              (error: unknown) => ({
                error:
                  error instanceof ScanProxyAuthError
                    ? "auth"
                    : error instanceof ScanUnavailableError
                      ? `unavailable:${error.attempts.map(a => (a.baseUrl === validator ? "proxy" : "scan")).join(",")}`
                      : error instanceof ScanApiError
                        ? `answer:${error.status}`
                        : `other:${error instanceof Error ? error.message : String(error)}`,
              }),
            );

            const scans = s.scan === "ok" ? { value: "scan" } : { error: "unavailable:scan" };
            let expected: { calls: string[]; result: unknown };
            if (s.token === "throws") {
              expected = { calls: [], result: { error: "other:no session" } };
            } else if (s.token === "none") {
              expected = { calls: ["scan"], result: scans };
            } else if (proxyCoolingUntil > now) {
              expected = { calls: ["scan"], result: scans };
            } else if (s.proxy === "ok") {
              proxyCoolingUntil = 0;
              expected = { calls: ["proxy"], result: { value: "proxy" } };
            } else if (s.proxy === "unauthorized") {
              expected = { calls: ["proxy"], result: { error: "auth" } };
            } else if (s.proxy === "answer") {
              expected = { calls: ["proxy"], result: { error: "answer:400" } };
            } else {
              proxyCoolingUntil = now + COOLDOWN_MS;
              expected = {
                calls: ["proxy", "scan"],
                result: s.scan === "ok" ? { value: "scan" } : { error: "unavailable:proxy,scan" },
              };
            }
            expect({ calls: [...calls], result }).toEqual(expected);
            vi.setSystemTime(Date.now() + s.advanceMs);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
