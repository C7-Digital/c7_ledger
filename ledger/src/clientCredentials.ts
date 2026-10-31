/**
 * Gets ledger access tokens for a service account through the OAuth 2.0
 * client-credentials grant, from any OpenID Connect issuer.
 */
import {
  allowInsecureRequests,
  clientCredentialsGrant,
  discovery,
  type Configuration,
} from "openid-client";

import type { MintedToken, TokenSource } from "./tokenRefresher";

export interface ClientCredentialsOptions {
  /** The issuer. Its `.well-known/openid-configuration` gives the token endpoint. */
  issuer: URL;
  clientId: string;
  clientSecret: string;
  /** Sent as the `audience` parameter. Some issuers (Auth0) need it. */
  audience?: string;
  scope?: string;
  /** Lets the requests use http. Use it only for a local issuer. */
  allowInsecureHttp?: boolean;
  /** The timeout of each request to the issuer. Default 10 s. */
  timeoutSeconds?: number;
}

const DEFAULT_TIMEOUT_SECONDS = 10;

export class ClientCredentialsTokenSource implements TokenSource {
  private configuration: Promise<Configuration> | null = null;

  constructor(private readonly opts: ClientCredentialsOptions) {}

  async mint(): Promise<MintedToken> {
    const config = await this.discover().catch((e: unknown) => {
      throw issuerError("discovery", this.opts.issuer, e);
    });
    const response = await clientCredentialsGrant(
      config,
      this.parameters(),
    ).catch((e: unknown) => {
      throw issuerError("token request", this.opts.issuer, e);
    });
    const lifetimeSeconds = response.expiresIn();
    if (lifetimeSeconds === undefined || lifetimeSeconds <= 0) {
      throw new Error("The token response has no positive expires_in");
    }
    return {
      token: response.access_token,
      expiresAt: new Date(Date.now() + lifetimeSeconds * 1000),
    };
  }

  /** Discovers the issuer once. A failed discovery runs again on the next mint. */
  private discover(): Promise<Configuration> {
    const { issuer, clientId, clientSecret, allowInsecureHttp } = this.opts;
    this.configuration ??= discovery(
      issuer,
      clientId,
      clientSecret,
      undefined,
      {
        execute: allowInsecureHttp ? [allowInsecureRequests] : [],
        timeout: this.opts.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
      },
    ).catch((e: unknown) => {
      this.configuration = null;
      throw e;
    });
    return this.configuration;
  }

  private parameters(): Record<string, string> {
    const { audience, scope } = this.opts;
    return {
      ...(audience ? { audience } : {}),
      ...(scope ? { scope } : {}),
    };
  }
}

/**
 * An error that names the step, the issuer, the HTTP status and the OAuth
 * error code. It reads the `openid-client` error by its shape, so that a
 * second copy of the package in the tree gives the same message.
 */
function issuerError(step: string, issuer: URL, e: unknown): Error {
  const fields = (v: unknown): Record<string, unknown> =>
    typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
  const err = fields(e);
  const status = err.status ?? fields(err.cause).status;
  const parts = [
    typeof status === "number" ? String(status) : null,
    typeof err.error === "string" ? err.error : null,
    typeof err.error_description === "string" ? err.error_description : null,
  ].filter((p): p is string => p !== null);
  // A network failure has no status; its cause names it (ECONNREFUSED).
  const code = fields(err.cause).code;
  const detail =
    parts.length > 0
      ? parts.join(" ")
      : `${e instanceof Error ? e.message : String(e)}${typeof code === "string" ? ` (${code})` : ""}`;
  return Object.assign(
    new Error(`OIDC ${step} to ${issuer.href} failed: ${detail}`),
    { cause: e },
  );
}
