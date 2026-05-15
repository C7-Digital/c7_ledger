import { User } from "@c7-digital/ledger/lite";

/**
 * Ledger-side credentials derived from an OIDC user. The token is the
 * access_token issued by the IdP; party is the user's primary Daml party,
 * obtained via `Ledger.getTokenUserInfo()`.
 */
export type Credentials = {
  party: string;
  token: string;
  user: User;
};

export default Credentials;
