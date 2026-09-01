import { Ledger } from "./ledger";
import {
  WebSocketClient,
  StopClient,
  ActiveContractsStreamRequest,
  ActiveContractsResponse,
  UpdatesStreamRequest,
  UpdatesResponse,
} from "./websocket";
import type { TemplateMapping } from "./types";

// Template ids the app would register, in package-name form. `#c7-lei` stands in
// for a template whose DAR is not yet on the participant.
const KNOWN_A = "#pkg-known-a:M:A";
const KNOWN_B = "#pkg-known-b:M:B";
const LEI = "#c7-lei:C7.LEI:LEI";

const tm: TemplateMapping = {
  [KNOWN_A]: { contractType: {}, keyType: undefined },
  [KNOWN_B]: { contractType: {}, keyType: undefined },
  [LEI]: { contractType: {}, keyType: undefined },
};

const PACKAGE_NAMES_NOT_FOUND: ActiveContractsResponse = {
  status: "error",
  error: {
    code: "PACKAGE_NAMES_NOT_FOUND",
    cause:
      "The following package names do not match upgradable packages uploaded on this participant: [c7-lei].",
    context: {},
    errorCategory: 11,
  },
};

// Short backoff so the re-widen test runs on real timers in milliseconds. (The
// repo avoids jest's fake timers, which are not injected under ESM.)
const FAST_BACKOFF = { rewidenBackoffMinMs: 10, rewidenBackoffMaxMs: 40 };

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// One recorded stream subscription plus the callbacks to drive it by hand.
interface Sub {
  kind: "acs" | "updates";
  templateIds: string[];
  // Loosely typed: the fake stores callbacks from two differently-typed stream
  // methods; the test drives them with hand-built response literals.
  onMessage: (m: any) => void;
  onClose?: (code: number, reason: string) => void;
}

function filtersByPartyOf(request: any): Record<string, any> {
  return (
    request.eventFormat?.filtersByParty ??
    request.updateFormat?.includeTransactions?.eventFormat?.filtersByParty
  );
}

function templateIdsOf(request: any): string[] {
  const fbp = filtersByPartyOf(request);
  const firstParty = Object.values(fbp)[0] as any;
  return firstParty.cumulative.map(
    (c: any) => c.identifierFilter.TemplateFilter.value.templateId as string
  );
}

// A transport that records every subscription instead of opening a socket, so a
// test can inspect which filters were sent and drive the response callbacks.
class FakeWs extends WebSocketClient {
  readonly subs: Sub[] = [];

  constructor() {
    super({ token: "t", wsBaseUrl: "ws://test" });
  }

  streamActiveContracts(
    request: ActiveContractsStreamRequest,
    onMessage: (m: ActiveContractsResponse) => void,
    _onError?: (e: Error) => void,
    onClose?: (code: number, reason: string) => void
  ): StopClient {
    this.subs.push({ kind: "acs", templateIds: templateIdsOf(request), onMessage, onClose });
    return () => {};
  }

  streamUpdates(
    request: UpdatesStreamRequest,
    onMessage: (m: UpdatesResponse) => void,
    _onError?: (e: Error) => void,
    onClose?: (code: number, reason: string) => void
  ): StopClient {
    this.subs.push({ kind: "updates", templateIds: templateIdsOf(request), onMessage, onClose });
    return () => {};
  }

  // Non-null indexed access for tests (jest asserts length first).
  sub(i: number): Sub {
    const s = this.subs[i];
    if (!s) throw new Error(`no subscription at index ${i} (have ${this.subs.length})`);
    return s;
  }
}

// Streams opened by a test, closed after it so no re-widen timer outlives it.
const openStreams: Array<{ close(): void }> = [];

async function startStream(fake: FakeWs, opts: Partial<typeof FAST_BACKOFF> = {}) {
  const ledger = new Ledger({
    token: "t",
    httpBaseUrl: "http://test",
    autoReconnect: true,
    webSocketClientFactory: () => fake,
    ...opts,
  });
  // Numeric offset + explicit readAs avoid any HTTP; skipAcs=false starts in ACS.
  const stream = await ledger.createMultiStream(tm, 0, false, false, ["alice"]);
  openStreams.push(stream);
  const errors: unknown[] = [];
  stream.onError(e => errors.push(e));
  stream.start();
  return { stream, errors };
}

describe("MultiStream drop-and-retry on PACKAGE_NAMES_NOT_FOUND", () => {
  afterEach(() => {
    // close() clears the re-widen/reconnect timers so none outlives the test.
    while (openStreams.length) openStreams.pop()!.close();
  });

  it("drops only the missing package and retries with the rest, surfacing no error", async () => {
    const fake = new FakeWs();
    const { errors } = await startStream(fake);

    // First subscription asks for everything, including the missing package.
    expect(fake.subs).toHaveLength(1);
    expect(fake.sub(0).kind).toBe("acs");
    expect(fake.sub(0).templateIds).toEqual(expect.arrayContaining([KNOWN_A, KNOWN_B, LEI]));

    // Participant rejects the whole subscription for the one unknown name.
    fake.sub(0).onMessage(PACKAGE_NAMES_NOT_FOUND);

    // It retries — a fresh ACS subscription with c7-lei dropped, the rest kept.
    expect(fake.subs).toHaveLength(2);
    expect(fake.sub(1).kind).toBe("acs");
    expect(fake.sub(1).templateIds).toEqual(expect.arrayContaining([KNOWN_A, KNOWN_B]));
    expect(fake.sub(1).templateIds).not.toContain(LEI);

    // The caller never sees the error — the stream degraded, it did not fail.
    expect(errors).toHaveLength(0);
  });

  it("re-widens to the full set after the backoff and stops once accepted", async () => {
    const fake = new FakeWs();
    const { errors } = await startStream(fake, FAST_BACKOFF);

    // Drop c7-lei (arms the re-widen timer).
    fake.sub(0).onMessage(PACKAGE_NAMES_NOT_FOUND);
    expect(fake.subs).toHaveLength(2);
    expect(fake.sub(1).templateIds).not.toContain(LEI);

    // After the backoff, it re-subscribes from ACS with the FULL set again.
    await delay(30);
    expect(fake.subs.length).toBeGreaterThanOrEqual(3);
    const rewiden = fake.sub(2);
    expect(rewiden.kind).toBe("acs");
    expect(rewiden.templateIds).toEqual(expect.arrayContaining([KNOWN_A, KNOWN_B, LEI]));

    // The DAR is now present: the full-set ACS completes without rejection, so
    // the stream transitions to updates on the full set and the loop ends.
    rewiden.onClose?.(1000, "");
    const afterHeal = fake.subs.length;
    const updates = fake.sub(afterHeal - 1);
    expect(updates.kind).toBe("updates");
    expect(updates.templateIds).toEqual(expect.arrayContaining([KNOWN_A, KNOWN_B, LEI]));

    // No further full-set ACS retries once healed.
    await delay(60);
    expect(fake.subs).toHaveLength(afterHeal);
    expect(errors).toHaveLength(0);
  });

  it("surfaces the error unchanged when no filter matches the reported name", async () => {
    const fake = new FakeWs();
    const { errors } = await startStream(fake);

    fake.sub(0).onMessage({
      status: "error",
      error: {
        code: "PACKAGE_NAMES_NOT_FOUND",
        cause: "...uploaded on this participant: [some-other-package].",
        context: {},
        errorCategory: 11,
      },
    });

    // Nothing matched, so there is no safe retry — do not loop, surface it.
    expect(fake.subs).toHaveLength(1);
    expect(errors).toHaveLength(1);
  });
});
