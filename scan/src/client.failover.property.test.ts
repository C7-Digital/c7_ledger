import fc from "fast-check";
import { afterEach, vi } from "vitest";
import { ScanClient } from "./client.js";
import { ScanApiError, ScanUnavailableError } from "./error.js";

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
