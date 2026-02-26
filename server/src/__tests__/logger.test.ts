import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Logger, LedgerLoggerAdapter, limitObjectDepth } from "../logger.js";

describe("limitObjectDepth", () => {
  it("returns primitives unchanged", () => {
    expect(limitObjectDepth("hello")).toBe("hello");
    expect(limitObjectDepth(42)).toBe(42);
    expect(limitObjectDepth(true)).toBe(true);
    expect(limitObjectDepth(undefined)).toBe(undefined);
  });

  it("returns null unchanged", () => {
    expect(limitObjectDepth(null)).toBe(null);
  });

  it("returns null at depth boundary", () => {
    expect(limitObjectDepth(null, 0)).toBe(null);
  });

  it("truncates objects at maxDepth with key count", () => {
    const obj = { a: { b: { c: "deep" } } };
    const result = limitObjectDepth(obj, 2);
    expect(result).toEqual({ a: { b: "[Object(1 keys)]" } });
  });

  it("truncates arrays at maxDepth with length", () => {
    const obj = { a: { b: [1, 2, 3] } };
    const result = limitObjectDepth(obj, 2);
    expect(result).toEqual({ a: { b: "[Array(3)]" } });
  });

  it("returns primitives at maxDepth unchanged", () => {
    const obj = { a: { b: 42 } };
    const result = limitObjectDepth(obj, 2);
    expect(result).toEqual({ a: { b: 42 } });
  });

  it("uses default depth of 6", () => {
    // Build a 7-level deep object
    let obj: any = { value: "leaf" };
    for (let i = 0; i < 6; i++) {
      obj = { nested: obj };
    }
    const result = limitObjectDepth(obj);
    // At depth 6, the innermost object should be truncated
    expect(JSON.stringify(result)).toContain("[Object(");
  });

  it("handles arrays at non-boundary depths", () => {
    const arr = [1, "two", { three: 3 }];
    const result = limitObjectDepth(arr, 3);
    expect(result).toEqual([1, "two", { three: 3 }]);
  });
});

describe("Logger", () => {
  let logger: Logger;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logger = new Logger();
    stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it("writes JSON to stdout for DEBUG", () => {
    logger.debug("test message");
    expect(stdoutSpy).toHaveBeenCalledOnce();
    const output = stdoutSpy.mock.calls[0]![0] as string;
    const parsed = JSON.parse(output.trim());
    expect(parsed.level).toBe("DEBUG");
    expect(parsed.message).toBe("test message");
    expect(parsed["@timestamp"]).toBeDefined();
  });

  it("writes JSON to stdout for INFO", () => {
    logger.info("info message");
    expect(stdoutSpy).toHaveBeenCalledOnce();
    const parsed = JSON.parse((stdoutSpy.mock.calls[0]![0] as string).trim());
    expect(parsed.level).toBe("INFO");
    expect(parsed.message).toBe("info message");
  });

  it("writes to both stderr and stdout for WARN", () => {
    logger.warn("warn message");
    expect(stderrSpy).toHaveBeenCalledOnce();
    expect(stdoutSpy).toHaveBeenCalledOnce();
    const stderrParsed = JSON.parse((stderrSpy.mock.calls[0]![0] as string).trim());
    expect(stderrParsed.level).toBe("WARN");
  });

  it("writes to both stderr and stdout for ERROR", () => {
    logger.error("error message");
    expect(stderrSpy).toHaveBeenCalledOnce();
    expect(stdoutSpy).toHaveBeenCalledOnce();
    const stderrParsed = JSON.parse((stderrSpy.mock.calls[0]![0] as string).trim());
    expect(stderrParsed.level).toBe("ERROR");
  });

  it("does not write to stderr for DEBUG or INFO", () => {
    logger.debug("debug");
    logger.info("info");
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("serializes error with name, message, and stack", () => {
    const err = new Error("something broke");
    logger.error("failed", err);
    const parsed = JSON.parse((stdoutSpy.mock.calls[0]![0] as string).trim());
    expect(parsed.error).toEqual({
      name: "Error",
      message: "something broke",
      stack: expect.any(String),
    });
  });

  it("spreads context into the log entry", () => {
    logger.info("with context", { requestId: "abc", count: 5 });
    const parsed = JSON.parse((stdoutSpy.mock.calls[0]![0] as string).trim());
    expect(parsed.requestId).toBe("abc");
    expect(parsed.count).toBe(5);
  });

  it("merges error and context in error()", () => {
    const err = new Error("oops");
    logger.error("fail", err, { extra: "data" });
    const parsed = JSON.parse((stdoutSpy.mock.calls[0]![0] as string).trim());
    expect(parsed.error.message).toBe("oops");
    expect(parsed.extra).toBe("data");
  });

  it("handles error() without an Error object", () => {
    logger.error("just a message", undefined, { info: "value" });
    const parsed = JSON.parse((stdoutSpy.mock.calls[0]![0] as string).trim());
    expect(parsed.error).toBeUndefined();
    expect(parsed.info).toBe("value");
  });

  it("output is newline-terminated", () => {
    logger.info("test");
    const output = stdoutSpy.mock.calls[0]![0] as string;
    expect(output.endsWith("\n")).toBe(true);
  });
});

describe("LedgerLoggerAdapter", () => {
  let logger: Logger;
  let adapter: LedgerLoggerAdapter;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logger = new Logger();
    adapter = new LedgerLoggerAdapter(logger);
    stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it("forwards debug with context: 'ledger'", () => {
    adapter.debug("ledger debug");
    const parsed = JSON.parse((stdoutSpy.mock.calls[0]![0] as string).trim());
    expect(parsed.context).toBe("ledger");
    expect(parsed.level).toBe("DEBUG");
  });

  it("forwards info with context: 'ledger'", () => {
    adapter.info("ledger info");
    const parsed = JSON.parse((stdoutSpy.mock.calls[0]![0] as string).trim());
    expect(parsed.context).toBe("ledger");
    expect(parsed.level).toBe("INFO");
  });

  it("forwards warn with context: 'ledger'", () => {
    adapter.warn("ledger warn");
    const parsed = JSON.parse((stderrSpy.mock.calls[0]![0] as string).trim());
    expect(parsed.context).toBe("ledger");
    expect(parsed.level).toBe("WARN");
  });

  it("extracts Error from args in error()", () => {
    const err = new Error("ledger error");
    adapter.error("failed", err, "extra-arg");
    const parsed = JSON.parse((stdoutSpy.mock.calls[0]![0] as string).trim());
    expect(parsed.error.message).toBe("ledger error");
    expect(parsed.context).toBe("ledger");
  });

  it("forwards error without Error in args", () => {
    adapter.error("no error object", "some-string");
    const parsed = JSON.parse((stdoutSpy.mock.calls[0]![0] as string).trim());
    expect(parsed.error).toBeUndefined();
    expect(parsed.context).toBe("ledger");
  });

  it("forwards log() as info", () => {
    adapter.log("log message");
    const parsed = JSON.parse((stdoutSpy.mock.calls[0]![0] as string).trim());
    expect(parsed.level).toBe("INFO");
    expect(parsed.context).toBe("ledger");
  });

  it("formatArgs returns undefined for empty args", () => {
    adapter.debug("no args");
    const parsed = JSON.parse((stdoutSpy.mock.calls[0]![0] as string).trim());
    expect(parsed.args).toBeUndefined();
  });

  it("formatArgs returns single arg unwrapped", () => {
    adapter.debug("one arg", "single");
    const parsed = JSON.parse((stdoutSpy.mock.calls[0]![0] as string).trim());
    expect(parsed.args).toBe("single");
  });

  it("formatArgs returns array for multiple args", () => {
    adapter.debug("multi args", "a", "b");
    const parsed = JSON.parse((stdoutSpy.mock.calls[0]![0] as string).trim());
    expect(parsed.args).toEqual(["a", "b"]);
  });
});
