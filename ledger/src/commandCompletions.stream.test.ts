/**
 * The two completion streams: which channel each opens, what it sends, and
 * how it reports the answer. `/v2/commands/command-completions` replaces the
 * channel that Canton 3.6 deprecates; both answer with the same messages.
 */
import { vi } from "vitest";

import { createPartyIdString, createUserIdString } from "./valueTypes";
import { WebSocketClient, type CompletionResponse } from "./websocket";

/** What a test reads from the socket that a stream opened. */
interface RecordedSocket {
  readonly url: string;
  readonly sent: string[];
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void | Promise<void>;
}

// The fake socket is hoisted with the mock that installs it.
const { FakeSocket } = vi.hoisted(() => {
  /** A socket that records its URL and what the client sends. */
  class FakeSocket {
    static readonly OPEN = 1;
    static last: RecordedSocket | undefined;
    readonly sent: string[] = [];
    readyState = FakeSocket.OPEN;
    onopen?: () => void;
    onmessage?: (event: { data: string }) => void;
    onclose?: (event: { code: number; reason: string }) => void;
    onerror?: (event: unknown) => void;

    constructor(readonly url: string) {
      FakeSocket.last = this;
    }

    send(data: string) {
      this.sent.push(data);
    }

    close() {
      this.readyState = 3;
    }
  }
  return { FakeSocket };
});

vi.mock("isomorphic-ws", () => ({ default: FakeSocket }));

const ALICE = createPartyIdString("alice::1220aa");
const ALICE_USER = createUserIdString("alice-user");

const client = () => new WebSocketClient({ token: "test-token", wsBaseUrl: "ws://participant" });

const completion = {
  completionResponse: {
    Completion: {
      value: {
        commandId: "cmd-1",
        status: { code: 0, message: "", details: [] },
        updateId: "update-1",
        userId: "alice-user",
        actAs: ["alice::1220aa"],
        offset: 7,
      },
    },
  },
};

function lastSocket(): RecordedSocket {
  const socket = FakeSocket.last;
  if (!socket) throw new Error("no socket was opened");
  return socket;
}

describe("completion streams", () => {
  it("streamCommandCompletions opens /v2/commands/command-completions and sends the request", () => {
    const request = { parties: [ALICE], beginExclusive: 5 };
    client().streamCommandCompletions(request, () => {});
    const socket = lastSocket();
    expect(socket.url).toBe("ws://participant/v2/commands/command-completions");
    socket.onopen?.();
    expect(socket.sent.map((s: string) => JSON.parse(s))).toEqual([request]);
  });

  it("streamCommandCompletions accepts a request without parties", () => {
    client().streamCommandCompletions({ beginExclusive: 0 }, () => {});
    const socket = lastSocket();
    socket.onopen?.();
    expect(socket.sent.map((s: string) => JSON.parse(s))).toEqual([{ beginExclusive: 0 }]);
  });

  it("streamCompletions still opens /v2/commands/completions", () => {
    client().streamCompletions({ userId: ALICE_USER, parties: [ALICE] }, () => {});
    expect(lastSocket().url).toBe("ws://participant/v2/commands/completions");
  });

  it.each([
    ["a completion", completion, "success"],
    [
      "a Canton error",
      { code: "PARTY_NOT_KNOWN", cause: "unknown", context: {}, errorCategory: 11 },
      "error",
    ],
  ])("streamCommandCompletions reports %s", async (_, message, status) => {
    const received: CompletionResponse[] = [];
    client().streamCommandCompletions({ parties: [ALICE] }, m => received.push(m));
    await lastSocket().onmessage?.({ data: JSON.stringify(message) });
    expect(received.map(r => r.status)).toEqual([status]);
  });
});
