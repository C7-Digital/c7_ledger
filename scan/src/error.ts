/**
 * The error a Scan request throws on a non-OK response.
 *
 * Deliberately field-for-field with `LedgerApiError` from `@c7-digital/ledger`,
 * because consumers handle both from the same `catch`: an app that reaches
 * Scan for mining-round context and then submits to the ledger can receive
 * either from one `await`. Matching shapes let it read `.status` once instead
 * of branching per client.
 */

/**
 * What a non-OK response carried, as read.
 *
 * Whether the body parsed as JSON is decided once, when it is read, and the
 * three outcomes are genuinely different things: an application error object,
 * text a server or proxy wrote for a human, or nothing at all. Naming them
 * keeps that knowledge instead of leaving a caller to re-derive it from
 * `typeof`, which cannot tell a JSON string literal from an HTML page.
 */
export type ScanErrorBody =
  | { readonly kind: "json"; readonly value: unknown }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "empty" };

/** How much of a response body belongs in a log line. */
const MESSAGE_BODY_CHARS = 120;

function summarize(body: ScanErrorBody): string | undefined {
  const text =
    body.kind === "text"
      ? body.text
      : body.kind === "json"
        ? safeJson(body.value)
        : "";
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
   * The response body, tagged with how it was read.
   *
   * A blocked or misrouted request answers with an HTML page here. That is the
   * caller's signal to report a connectivity problem rather than show the
   * body, so it must survive intact — which is why the full value lives on
   * this field and only a bounded summary reaches {@link message}.
   */
  public readonly body: ScanErrorBody;

  constructor(status: number, statusText: string, body: ScanErrorBody) {
    const detail = summarize(body);
    super(
      detail
        ? `HTTP ${status}: ${statusText} — ${detail}`
        : `HTTP ${status}: ${statusText}`,
    );
    this.name = "ScanApiError";
    this.status = status;
    this.statusText = statusText;
    this.body = body;
  }

  /**
   * The untagged body, matching `LedgerApiError.responseBody` so a consumer
   * that handles either client reads one field. Derived from {@link body},
   * which is the source of truth.
   */
  public get responseBody(): unknown {
    switch (this.body.kind) {
      case "json":
        return this.body.value;
      case "text":
        return this.body.text;
      case "empty":
        return undefined;
    }
  }
}

/**
 * Read a non-OK response into the body {@link ScanApiError} carries.
 *
 * Text first, then parse. Reading with `json()` and falling back to `text()`
 * does not work: `json()` consumes the stream even when it throws, so the
 * fallback raises "Body is unusable" and the body is lost — which is exactly
 * what silently discarded every HTML error page in `@c7-digital/ledger` before
 * 0.0.33.
 */
export async function readErrorBody(
  response: Response,
): Promise<ScanErrorBody> {
  let raw: string;
  try {
    raw = await response.text();
  } catch {
    return { kind: "empty" };
  }
  if (raw === "") return { kind: "empty" };
  try {
    return { kind: "json", value: JSON.parse(raw) };
  } catch {
    return { kind: "text", text: raw };
  }
}
