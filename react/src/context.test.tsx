import React from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Regression test for the early-stream-close race (#38).
//
// `useStreamBase` creates the stream via `await createStream()`. If the effect
// is cleaned up (unmount, or a dependency change that re-runs the effect) WHILE
// that await is in flight, the resolved stream must be closed — not started and
// leaked. The first fix used a single shared `isCleanedUpRef`, which the next
// effect run reset to `false`, so a superseded run's late-resolving stream slid
// through and leaked. The fix is a per-effect-run cancellation flag; these tests
// lock that behaviour for both the single- and multi-stream bases.
// ---------------------------------------------------------------------------

// A controllable stream factory. Each createStream() call yields a deferred
// promise the test resolves on demand, so we can interleave resolution with
// unmount / dependency changes to drive the race deterministically.
const streamHarness = vi.hoisted(() => {
  type MockStream = {
    on: ReturnType<typeof vi.fn>;
    onState: ReturnType<typeof vi.fn>;
    onError: ReturnType<typeof vi.fn>;
    start: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    state: ReturnType<typeof vi.fn>;
    updateToken: ReturnType<typeof vi.fn>;
  };
  type Deferred = { promise: Promise<MockStream>; resolve: () => void; stream: MockStream };
  const deferreds: Deferred[] = [];
  const makeStream = (): MockStream => ({
    on: vi.fn(),
    onState: vi.fn(),
    onError: vi.fn(),
    start: vi.fn(),
    close: vi.fn(),
    state: vi.fn(() => "start"),
    updateToken: vi.fn(),
  });
  return {
    deferreds,
    newDeferred(): Deferred {
      const stream = makeStream();
      let resolve!: () => void;
      const promise = new Promise<MockStream>((res) => {
        resolve = () => res(stream);
      });
      const d: Deferred = { promise, resolve, stream };
      deferreds.push(d);
      return d;
    },
    reset(): void {
      deferreds.length = 0;
    },
  };
});

// The Ledger that DamlLedger instantiates internally. streamQuery /
// createMultiStream hand back deferred streams from the harness.
vi.mock("@c7-digital/ledger/lite", () => ({
  Ledger: class {
    token: string;
    constructor(opts: { token: string }) {
      this.token = opts.token;
    }
    setToken(token: string): void {
      this.token = token;
    }
    streamQuery = vi.fn(() => streamHarness.newDeferred().promise);
    createMultiStream = vi.fn(() => streamHarness.newDeferred().promise);
  },
}));

import { DamlLedger, useStreamQuery, useMultiStreamQuery } from "./context";

const TEMPLATE = (templateId: string) => ({ templateId }) as never;

const StreamConsumer: React.FC<{ tid: string }> = ({ tid }) => {
  useStreamQuery(TEMPLATE(tid));
  return null;
};

const MultiStreamConsumer: React.FC<{ tid: string }> = ({ tid }) => {
  useMultiStreamQuery({ [tid]: { contractType: {}, keyType: undefined } } as never);
  return null;
};

const wrap = (node: React.ReactNode) =>
  React.createElement(DamlLedger, { token: "tok", httpBaseUrl: "http://ledger.test" } as never, node);

afterEach(() => {
  cleanup();
  streamHarness.reset();
  vi.clearAllMocks();
});

describe("useStreamBase early-close race", () => {
  it("closes (not starts) a stream that resolves after the component unmounts", async () => {
    const { unmount } = render(wrap(<StreamConsumer tid="Pkg:Mod:A" />));

    // The effect ran and called createStream(); its promise is still pending.
    expect(streamHarness.deferreds).toHaveLength(1);
    const d = streamHarness.deferreds[0];

    // Unmount before the stream resolves → the effect cleanup runs.
    unmount();

    // Now the in-flight createStream() resolves.
    await act(async () => {
      d.resolve();
      await d.promise;
    });

    // The orphaned stream must be closed and never started / wired up.
    expect(d.stream.close).toHaveBeenCalledTimes(1);
    expect(d.stream.start).not.toHaveBeenCalled();
    expect(d.stream.on).not.toHaveBeenCalled();
  });

  it("closes the superseded stream when a dependency change re-runs the effect mid-await", async () => {
    // This is the exact case the shared-ref fix got wrong: the second run reset
    // the shared flag, so run #1's late stream observed `false` and leaked.
    const { rerender } = render(wrap(<StreamConsumer tid="Pkg:Mod:A" />));
    expect(streamHarness.deferreds).toHaveLength(1);

    // Change the template id → useStreamBase deps change → cleanup run #1, start run #2,
    // all while run #1's createStream() is still pending.
    rerender(wrap(<StreamConsumer tid="Pkg:Mod:B" />));
    expect(streamHarness.deferreds).toHaveLength(2);

    const [first, second] = streamHarness.deferreds;
    await act(async () => {
      first.resolve(); // the superseded run
      second.resolve(); // the live run
      await Promise.all([first.promise, second.promise]);
    });

    // Superseded run: closed, never started (the regression).
    expect(first.stream.close).toHaveBeenCalledTimes(1);
    expect(first.stream.start).not.toHaveBeenCalled();

    // Live run: started, not closed.
    expect(second.stream.start).toHaveBeenCalledTimes(1);
    expect(second.stream.close).not.toHaveBeenCalled();
  });
});

describe("useMultiStreamBase early-close race", () => {
  it("closes the superseded multi-stream when a dependency change re-runs the effect mid-await", async () => {
    const { rerender } = render(wrap(<MultiStreamConsumer tid="Pkg:Mod:A" />));
    expect(streamHarness.deferreds).toHaveLength(1);

    rerender(wrap(<MultiStreamConsumer tid="Pkg:Mod:B" />));
    expect(streamHarness.deferreds).toHaveLength(2);

    const [first, second] = streamHarness.deferreds;
    await act(async () => {
      first.resolve();
      second.resolve();
      await Promise.all([first.promise, second.promise]);
    });

    expect(first.stream.close).toHaveBeenCalledTimes(1);
    expect(first.stream.start).not.toHaveBeenCalled();

    expect(second.stream.start).toHaveBeenCalledTimes(1);
    expect(second.stream.close).not.toHaveBeenCalled();
  });
});
