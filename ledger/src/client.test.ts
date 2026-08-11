/**
 * How a non-OK response becomes a LedgerApiError.
 *
 * The behaviour under test is narrow but was wrong in a way that hid itself:
 * the error path read the body with `json()` and fell back to `text()`. A
 * failed `json()` has already consumed the stream, so the fallback threw
 * "Body is unusable" and was swallowed — every non-JSON error body was
 * discarded. A proxy's HTML "403 Forbidden" page in front of the ledger
 * reached callers as a bare status with no body, stripping the one clue that
 * the request never got past the network.
 */
import { TypedHttpClient, LedgerApiError } from "./client";
import type { JsCantonError } from "./types";

const TEST_TOKEN =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0ZXN0LXVzZXIiLCJpYXQiOjE1MTYyMzkwMjJ9.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";

/**
 * A `Response` whose body may be read exactly once — the property the old
 * implementation violated. A second read rejects the way the platform's does,
 * so a regression fails here rather than silently losing the body again.
 */
function oneShotResponse(status: number, statusText: string, body: string): Response {
  let consumed = false;
  const read = async () => {
    if (consumed) throw new TypeError("Body is unusable: Body has already been read");
    consumed = true;
    return body;
  };
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    text: read,
    json: async () => JSON.parse(await read()),
  } as unknown as Response;
}

function clientReturning(response: Response): TypedHttpClient {
  // A plain stub rather than `jest.fn()`: under ESM the `jest` global is not
  // injected, and nothing here inspects the call.
  globalThis.fetch = (async () => response) as unknown as typeof fetch;
  return new TypedHttpClient({
    token: TEST_TOKEN,
    baseUrl: "http://localhost:7575",
  });
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function captureError(client: TypedHttpClient): Promise<LedgerApiError> {
  try {
    await client.submitAndWait({} as never);
  } catch (e) {
    return e as LedgerApiError;
  }
  throw new Error("expected the request to reject");
}

describe("non-OK responses", () => {
  it("keeps an HTML error page as the response body", async () => {
    const html = "<html><head><title>403 Forbidden</title></head><body>nginx</body></html>";
    const err = await captureError(clientReturning(oneShotResponse(403, "Forbidden", html)));

    expect(err).toBeInstanceOf(LedgerApiError);
    expect(err.status).toBe(403);
    // The whole point: the markup survives, so a caller can recognise an infra
    // page and say "the connection was blocked" instead of dumping a status.
    expect(err.responseBody).toBe(html);
    expect(err.message).toContain("403 Forbidden");
    expect(err.cantonError).toBeUndefined();
  });

  it("still parses a Canton error body into cantonError", async () => {
    const canton: JsCantonError = {
      code: "CONTRACT_NOT_FOUND",
      cause: "Contract could not be found with id 001b68f5",
      context: {},
      errorCategory: 11,
      grpcCodeValue: 5,
    };
    const err = await captureError(
      clientReturning(oneShotResponse(404, "Not Found", JSON.stringify(canton)))
    );

    expect(err.cantonError).toEqual(canton);
    expect(err.message).toBe(
      "HTTP 404: Not Found — CONTRACT_NOT_FOUND: Contract could not be found with id 001b68f5"
    );
  });

  it("keeps a plain-text body", async () => {
    const err = await captureError(
      clientReturning(oneShotResponse(502, "Bad Gateway", "upstream connect error"))
    );
    expect(err.responseBody).toBe("upstream connect error");
    expect(err.message).toContain("upstream connect error");
  });

  it("leaves the body undefined when the response is empty", async () => {
    // Nothing to report is different from something we failed to read.
    const err = await captureError(clientReturning(oneShotResponse(500, "Internal Server Error", "")));
    expect(err.responseBody).toBeUndefined();
    expect(err.message).toBe("HTTP 500: Internal Server Error");
  });

  it("does not classify valid JSON that is not a Canton payload", async () => {
    const err = await captureError(
      clientReturning(oneShotResponse(400, "Bad Request", JSON.stringify({ detail: "nope" })))
    );
    expect(err.cantonError).toBeUndefined();
    expect(err.responseBody).toEqual({ detail: "nope" });
  });
});
