/**
 * The error a Scan request throws on a non-OK response.
 *
 * Deliberately field-for-field with `LedgerApiError` from `@c7-digital/ledger`,
 * because consumers handle both from the same `catch`: an app that reaches
 * Scan for mining-round context and then submits to the ledger can receive
 * either from one `await`. Matching shapes let it read `.status` once instead
 * of branching per client.
 */

/** How much of a response body belongs in a log line. */
const MESSAGE_BODY_CHARS = 120;

function summarize(body: unknown): string | undefined {
  const text =
    typeof body === "string"
      ? body
      : body === undefined
        ? ""
        : safeJson(body);
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return undefined;
  return flat.length <= MESSAGE_BODY_CHARS
    ? flat
    : `${flat.slice(0, MESSAGE_BODY_CHARS - 1)}…`;
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? "";
  } catch {
    return "";
  }
}

export class ScanApiError extends Error {
  public readonly status: number;
  public readonly statusText: string;
  /**
   * The response body: the parsed JSON when it was JSON, the raw text when it
   * was not, `undefined` when it was empty or unreadable.
   *
   * A blocked or misrouted request answers with an HTML page here. That is the
   * caller's signal to report a connectivity problem rather than show the
   * body, so it must survive intact — which is why the full value lives on
   * this field and only a bounded summary reaches {@link message}.
   */
  public readonly responseBody?: unknown;

  constructor(status: number, statusText: string, body?: unknown) {
    const detail = summarize(body);
    super(
      detail
        ? `HTTP ${status}: ${statusText} — ${detail}`
        : `HTTP ${status}: ${statusText}`,
    );
    this.name = "ScanApiError";
    this.status = status;
    this.statusText = statusText;
    if (body !== undefined && body !== "") {
      this.responseBody = body;
    }
  }
}

/**
 * Read a non-OK response into the body value {@link ScanApiError} carries.
 *
 * Text first, then parse. Reading with `json()` and falling back to `text()`
 * does not work: `json()` consumes the stream even when it throws, so the
 * fallback raises "Body is unusable" and the body is lost — which is exactly
 * what silently discarded every HTML error page in `@c7-digital/ledger` before
 * 0.0.33.
 */
export async function readErrorBody(response: Response): Promise<unknown> {
  let raw: string;
  try {
    raw = await response.text();
  } catch {
    return undefined;
  }
  if (raw === "") return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
