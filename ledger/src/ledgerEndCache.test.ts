// A query at "end" must see this instance's own writes, even inside the
// one-second ledger-end cache window.
import { Ledger } from "./ledger";

// Header: {"alg":"HS256","typ":"JWT"}
// Payload: {"sub":"test-user","iat":1516239022}
const TEST_TOKEN =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0ZXN0LXVzZXIiLCJpYXQiOjE1MTYyMzkwMjJ9.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
const PARTY = "alice::1220";
const TEMPLATE = { templateId: "#pkg:Mod:T" } as never;

function json(body: unknown): Response {
  const text = JSON.stringify(body);
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    text: async () => text,
    json: async () => body,
  } as unknown as Response;
}

/**
 * Stub the JSON Ledger API: the ledger end is `ledgerEnd`, a submit commits
 * at `ledgerEnd + 1`, and every ACS query's `activeAtOffset` is recorded.
 */
function stubLedger(initialEnd: number): {
  acsOffsets: number[];
  ledgerEndReads: () => number;
} {
  let ledgerEnd = initialEnd;
  let reads = 0;
  const acsOffsets: number[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    if (path === "/v2/state/ledger-end") {
      reads += 1;
      return json({ offset: ledgerEnd });
    }
    if (path === "/v2/commands/submit-and-wait-for-transaction") {
      ledgerEnd += 1;
      return json({
        transaction: {
          updateId: "u",
          commandId: "c",
          workflowId: "",
          effectiveAt: "2026-10-02T00:00:00Z",
          events: [],
          offset: ledgerEnd,
          synchronizerId: "sync::1",
          recordTime: "2026-10-02T00:00:00Z",
        },
      });
    }
    if (path === "/v2/state/active-contracts") {
      acsOffsets.push(JSON.parse(String(init?.body)).activeAtOffset);
      return json([]);
    }
    throw new Error(`unexpected request ${path}`);
  }) as unknown as typeof fetch;
  return { acsOffsets, ledgerEndReads: () => reads };
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Ledger ledger-end cache", () => {
  it("reads at the offset of this instance's last submit", async () => {
    const { acsOffsets } = stubLedger(10);
    const ledger = new Ledger({
      token: TEST_TOKEN,
      httpBaseUrl: "http://localhost:7575",
    });

    await ledger.query(TEMPLATE, "end", false, false, [PARTY]);
    await ledger.submit([], [PARTY]);
    await ledger.query(TEMPLATE, "end", false, false, [PARTY]);

    expect(acsOffsets).toEqual([10, 11]);
  });

  it("uses the submit's offset without reading the ledger end", async () => {
    const { acsOffsets, ledgerEndReads } = stubLedger(10);
    const ledger = new Ledger({
      token: TEST_TOKEN,
      httpBaseUrl: "http://localhost:7575",
    });

    await ledger.submit([], [PARTY]);
    await ledger.query(TEMPLATE, "end", false, false, [PARTY]);

    expect(acsOffsets).toEqual([11]);
    expect(ledgerEndReads()).toBe(0);
  });
});
