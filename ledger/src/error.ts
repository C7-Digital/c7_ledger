/**
 * The error a Ledger API request throws on a non-OK response.
 *
 * Kept field-for-field with `ScanApiError` from `@c7-digital/scan`, because
 * consumers handle both from the same `catch`: an app that reaches Scan for
 * mining-round context and then submits to the ledger can receive either from
 * one `await`. Matching shapes let it read `.status` once instead of branching
 * per client.
 */
import { isCantonError, type JsCantonError } from "./types";

/**
 * What a non-OK response carried, as read.
 *
 * Whether the body parsed as JSON, and whether that JSON was a Canton payload,
 * is decided once — when it is read — and the four outcomes are genuinely
 * different things: a rejection Canton can explain, some other structured
 * error, text a server or proxy wrote for a human, or nothing at all. Naming
 * them keeps that knowledge instead of leaving a caller to re-derive it from
 * `typeof`, which cannot tell a JSON string literal from an HTML page.
 */
export type LedgerErrorBody =
  | { readonly kind: "canton"; readonly error: JsCantonError }
  | { readonly kind: "json"; readonly value: unknown }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "empty" };

/** How much of a response body belongs in a log line. */
const MESSAGE_BODY_CHARS = 120;

function summarize(body: LedgerErrorBody): string | undefined {
  const text =
    body.kind === "canton"
      ? `${body.error.code}: ${body.error.cause}`
      : body.kind === "text"
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

/**
 * Error thrown when the Canton ledger API returns a non-OK HTTP response.
 * Captures the HTTP status, status text, and the response body.
 */
export class LedgerApiError extends Error {
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
  public readonly body: LedgerErrorBody;

  constructor(
    status: number,
    statusText: string,
    body: LedgerErrorBody = { kind: "empty" },
  ) {
    const detail = summarize(body);
    super(
      detail
        ? `HTTP ${status}: ${statusText} — ${detail}`
        : `HTTP ${status}: ${statusText}`,
    );
    this.name = "LedgerApiError";
    this.status = status;
    this.statusText = statusText;
    this.body = body;
  }

  /**
   * The structured Canton rejection, when the body was one. This property name
   * is the contract `cantonErrorOf` probes for; it is derived from
   * {@link body}, which is the source of truth.
   */
  public get cantonError(): JsCantonError | undefined {
    return this.body.kind === "canton" ? this.body.error : undefined;
  }

  /**
   * The untagged body, matching `ScanApiError.responseBody` so a consumer that
   * handles either client reads one field. Derived from {@link body}.
   */
  public get responseBody(): unknown {
    switch (this.body.kind) {
      case "canton":
        return this.body.error;
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
 * Read a non-OK response into the body {@link LedgerApiError} carries.
 *
 * Text first, then parse. Reading with `json()` and falling back to `text()`
 * does not work: `json()` consumes the stream even when it throws, so the
 * fallback raises "Body is unusable" and the body is lost — which silently
 * discarded exactly the responses the fallback existed for. A proxy's HTML
 * "403 Forbidden" page in front of the ledger reached callers as a bare
 * `HTTP 403: Forbidden`, stripping the one clue that the request never got
 * past the network.
 */
export async function readErrorBody(
  response: Response,
): Promise<LedgerErrorBody> {
  let raw: string;
  try {
    raw = await response.text();
  } catch {
    return { kind: "empty" };
  }
  if (raw === "") return { kind: "empty" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "text", text: raw };
  }
  return isCantonError(parsed)
    ? { kind: "canton", error: parsed }
    : { kind: "json", value: parsed };
}
