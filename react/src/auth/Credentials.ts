import { User } from "@c7-digital/ledger/lite";

/**
 * Ledger-side credentials derived from an OIDC user. The token is the
 * access_token issued by the IdP; party is the user's primary Daml party,
 * obtained via `Ledger.getTokenUserInfo()`.
 *
 * `source` lets the AuthProvider tell OIDC-derived credentials apart from
 * directly-injected ones — only "oidc" credentials are auto-invalidated
 * when the OIDC session can't be recovered. Defaults to "manual" when
 * unset, which is the safe choice for dev/token-login flows.
 */
export type Credentials = {
  party: string;
  token: string;
  user: User;
  source?: "oidc" | "manual";
};
