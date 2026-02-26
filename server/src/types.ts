export interface KeycloakConfig {
  url: string;
  realm: string;
  clientId: string;
  clientSecret: string;
}

export type TokenUpdateCallback = (token: string) => Promise<void>;
