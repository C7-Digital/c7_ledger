import { Ledger } from "@c7-digital/ledger/lite";
import { decodeJwt } from "jose";
import { User } from "oidc-client-ts";

import type { Credentials } from "./Credentials";

/**
 * Build the OIDC config object expected by `react-oidc-context`'s
 * AuthProvider. `audience` is the optional `audience` extra query param
 * used by Auth0-style IdPs; pure-Keycloak setups can omit it.
 *
 * Scope is fixed at "openid daml_ledger_api" — `openid` is required so
 * the IdP issues an `id_token`, which the AuthProvider uses to send
 * `id_token_hint` on logout (Keycloak rejects logout redirects
 * otherwise).
 */
export function createOidcConfig(
  authority: string,
  clientId: string,
  audience?: string,
  redirectUri?: string,
) {
  const config = {
    authority,
    client_id: clientId,
    redirect_uri: redirectUri ?? (typeof window !== "undefined" ? window.location.origin + "/" : "/"),
    scope: "openid daml_ledger_api",
  };
  return audience
    ? { ...config, extraQueryParams: { audience } }
    : config;
}

/**
 * Exchange a signed-in OIDC user for a Daml `Ledger` instance + the
 * `Credentials` shape downstream UI code uses. Looks up the primary
 * party via `getTokenUserInfo` so the caller doesn't have to.
 *
 * `httpBaseUrl` is the JSON Ledger API base. Pass `window.location.origin`
 * when the app proxies `/v2/*` (the dv pattern), or a fully-qualified
 * URL when hitting the participant directly.
 */
export async function oidcUserToLedgerAndCredentials(
  user: User,
  httpBaseUrl: string,
): Promise<{ ledger: Ledger; credentials: Credentials }> {
  const token = user.access_token as string;
  const ledger = new Ledger({ token, httpBaseUrl });
  const ledgerUser = await ledger.getTokenUserInfo();
  if (ledgerUser === null) {
    throw new Error(
      `User '${user.profile?.name ?? user.profile?.sub}' has no primary party`,
    );
  }
  const primaryParty = ledgerUser.primaryParty;
  if (primaryParty === undefined) {
    const payload = decodeJwt(token) as Record<string, string>;
    throw new Error(`User '${payload.sub}' has no primary party`);
  }
  return {
    ledger,
    credentials: { party: primaryParty, token, user: ledgerUser },
  };
}
