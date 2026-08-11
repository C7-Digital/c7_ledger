import { ScanApiError, readErrorBody } from "./error.js";

/**
 * A `Response` whose body may be read exactly once — the property that makes
 * `json()`-then-`text()` lose the body. A second read rejects the way the
 * platform's does, so a regression fails here.
 */
function oneShotResponse(body: string): Response {
  let consumed = false;
  return {
    text: async () => {
      if (consumed) {
        throw new TypeError("Body is unusable: Body has already been read");
      }
      consumed = true;
      return body;
    },
  } as unknown as Response;
}

describe("readErrorBody", () => {
  it("parses a JSON body", async () => {
    const body = await readErrorBody(oneShotResponse('{"error":"nope"}'));
    expect(body).toEqual({ error: "nope" });
  });

  it("keeps a non-JSON body as text", async () => {
    // The case that matters: a proxy in front of Scan answers with markup.
    const html = "<html><head><title>403 Forbidden</title></head></html>";
    expect(await readErrorBody(oneShotResponse(html))).toBe(html);
  });

  it("reads the body only once", async () => {
    // Reading with `json()` first and falling back to `text()` consumes the
    // stream on the way past, and the fallback then throws.
    const response = oneShotResponse("not json");
    expect(await readErrorBody(response)).toBe("not json");
    await expect(response.text()).rejects.toThrow(/Body is unusable/);
  });

  it("reports an empty body as undefined", async () => {
    expect(await readErrorBody(oneShotResponse(""))).toBeUndefined();
  });

  it("reports an unreadable body as undefined rather than throwing", async () => {
    const broken = {
      text: async () => {
        throw new TypeError("network error");
      },
    } as unknown as Response;
    expect(await readErrorBody(broken)).toBeUndefined();
  });
});

describe("ScanApiError", () => {
  it("exposes the status as data, not only as prose", () => {
    // The whole point: a consumer reads `.status` instead of regexing
    // `/^HTTP (\d{3}):/` back out of the message.
    const err = new ScanApiError(403, "Forbidden", "blocked");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("ScanApiError");
    expect(err.status).toBe(403);
    expect(err.statusText).toBe("Forbidden");
    expect(err.responseBody).toBe("blocked");
  });

  it("keeps a whole HTML page on responseBody and out of the message", () => {
    // `pulse` logs `.message`; an unbounded body there puts a full error page
    // in a log line. The page still has to survive intact, because that is how
    // a caller tells an infra page from an application message.
    const page = `<html>${"x".repeat(4000)}</html>`;
    const err = new ScanApiError(403, "Forbidden", page);
    expect(err.message.length).toBeLessThan(200);
    expect(err.message).toContain("HTTP 403: Forbidden");
    expect(err.responseBody).toBe(page);
  });

  it("collapses whitespace in the message summary", () => {
    const err = new ScanApiError(500, "Internal Server Error", "line one\n\n   line two");
    expect(err.message).toBe(
      "HTTP 500: Internal Server Error — line one line two",
    );
  });

  it("omits the separator when there is no body", () => {
    const err = new ScanApiError(502, "Bad Gateway");
    expect(err.message).toBe("HTTP 502: Bad Gateway");
    expect(err.responseBody).toBeUndefined();
  });

  it("summarizes a structured body without losing it", () => {
    const err = new ScanApiError(400, "Bad Request", { error: "bad party id" });
    expect(err.message).toContain("bad party id");
    expect(err.responseBody).toEqual({ error: "bad party id" });
  });

  it("survives a body that cannot be serialized", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const err = new ScanApiError(500, "Internal Server Error", circular);
    expect(err.message).toBe("HTTP 500: Internal Server Error");
    expect(err.responseBody).toBe(circular);
  });
});
