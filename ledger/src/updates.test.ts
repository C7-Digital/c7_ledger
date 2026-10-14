/**
 * Reading the update history as whole transactions.
 *
 * `TypedHttpClient.getUpdates` sends `POST /v2/updates` with an optional
 * `limit` query parameter, and `Ledger.getTransactionPage` turns one page into
 * transactions plus the offset the page reached. The participant cuts a page
 * at its own element limit without a continuation token, so the reached
 * offset — not the page size — tells the caller where to read next.
 */
import { TypedHttpClient } from "./client";
import { Ledger } from "./ledger";
import type { components } from "./generated/api";

type Schemas = components["schemas"];

const TEST_TOKEN =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0ZXN0LXVzZXIiLCJpYXQiOjE1MTYyMzkwMjJ9.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
const BASE = "http://localhost:7575";

type Captured = { url: string; method?: string; body?: unknown };

// A plain stub rather than a mock function: the test reads the captured
// calls itself.
function serve(responseBody: unknown): Captured[] {
  const calls: Captured[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      method: init?.method,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response(JSON.stringify(responseBody), { status: 200 });
  }) as unknown as typeof fetch;
  return calls;
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const transaction = (
  offset: number,
  updateId: string,
  events: Schemas["Event"][] = [],
): Schemas["JsGetUpdatesResponse"] => ({
  update: {
    Transaction: {
      value: {
        updateId,
        offset,
        effectiveAt: "2026-10-13T12:00:00Z",
        recordTime: "2026-10-13T12:00:00Z",
        synchronizerId: "sync::1220",
        events,
      } as Schemas["JsTransaction"],
    },
  },
});

const checkpoint = (offset: number): Schemas["JsGetUpdatesResponse"] => ({
  update: {
    OffsetCheckpoint: { value: { offset, synchronizerTimes: [] } },
  },
});

const client = () => new TypedHttpClient({ token: TEST_TOKEN, baseUrl: BASE });
const ledger = () => new Ledger({ token: TEST_TOKEN, httpBaseUrl: BASE });

describe("TypedHttpClient.getParticipantId", () => {
  it("reads the participant id", async () => {
    const calls = serve({ participantId: "node::1220aa" });
    await expect(client().getParticipantId()).resolves.toEqual({
      participantId: "node::1220aa",
    });
    expect(calls).toEqual([
      { url: `${BASE}/v2/parties/participant-id`, method: "GET", body: undefined },
    ]);
  });
});

describe("TypedHttpClient.getUpdates", () => {
  const request: Schemas["GetUpdatesRequest"] = {
    beginExclusive: 10,
    endInclusive: 20,
  };

  it("posts the request and passes the limit as a query parameter", async () => {
    const calls = serve([]);
    await client().getUpdates(request, { limit: 50 });
    expect(calls).toEqual([
      { url: `${BASE}/v2/updates?limit=50`, method: "POST", body: request },
    ]);
  });

  it("sends no query string without a limit", async () => {
    const calls = serve([]);
    await client().getUpdates(request);
    expect(calls[0]!.url).toBe(`${BASE}/v2/updates`);
  });

  it.each([-1, 1.5, Number.NaN])("rejects limit %p before any request", async limit => {
    const calls = serve([]);
    await expect(client().getUpdates(request, { limit })).rejects.toThrow(RangeError);
    expect(calls).toEqual([]);
  });
});

describe("Ledger.getParticipantId", () => {
  it("returns the participant id string", async () => {
    serve({ participantId: "node::1220aa" });
    await expect(ledger().getParticipantId()).resolves.toBe("node::1220aa");
  });
});

describe("Ledger.getTransactionPage", () => {
  const exercised = (choice: string): Schemas["Event"] => ({
    ExercisedEvent: { choice } as Schemas["ExercisedEvent"],
  });

  it("filters by the given parties with ledger effects by default", async () => {
    const calls = serve([]);
    await ledger().getTransactionPage(
      { beginExclusive: 0, endInclusive: 5 },
      { parties: ["Alice::1220", "Bob::1220"] },
    );
    const body = calls[0]!.body as Schemas["GetUpdatesRequest"];
    expect(body.beginExclusive).toBe(0);
    expect(body.endInclusive).toBe(5);
    const format = body.updateFormat!.includeTransactions!;
    expect(format.transactionShape).toBe("TRANSACTION_SHAPE_LEDGER_EFFECTS");
    expect(Object.keys(format.eventFormat.filtersByParty!)).toEqual([
      "Alice::1220",
      "Bob::1220",
    ]);
    expect(format.eventFormat.filtersByParty!["Alice::1220"]).toEqual({
      cumulative: [
        { identifierFilter: { WildcardFilter: { value: { includeCreatedEventBlob: false } } } },
      ],
    });
  });

  it("keeps whole transactions, with their exercised choices", async () => {
    serve([transaction(3, "u3", [exercised("Transfer")]), transaction(4, "u4")]);
    const page = await ledger().getTransactionPage(
      { beginExclusive: 0, endInclusive: 10 },
      { parties: ["Alice::1220"] },
    );
    expect(page.transactions.map(t => t.updateId)).toEqual(["u3", "u4"]);
    expect(page.transactions[0]!.events).toEqual([exercised("Transfer")]);
  });

  it("reaches the last offset a cut page holds", async () => {
    serve([transaction(3, "u3"), checkpoint(7)]);
    const page = await ledger().getTransactionPage(
      { beginExclusive: 0, endInclusive: 10 },
      { parties: ["Alice::1220"] },
    );
    expect(page.reachedOffset).toBe(7);
  });

  it("reaches the end when the range has nothing more", async () => {
    serve([]);
    const page = await ledger().getTransactionPage(
      { beginExclusive: 7, endInclusive: 10 },
      { parties: ["Alice::1220"] },
    );
    expect(page).toEqual({ transactions: [], reachedOffset: 10 });
  });

  it("makes no request for an empty range", async () => {
    const calls = serve([]);
    const page = await ledger().getTransactionPage(
      { beginExclusive: 10, endInclusive: 10 },
      { parties: ["Alice::1220"] },
    );
    expect(page).toEqual({ transactions: [], reachedOffset: 10 });
    expect(calls).toEqual([]);
  });
});
