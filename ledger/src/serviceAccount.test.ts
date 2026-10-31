import * as LedgerPackage from "./index";
import * as ServiceAccount from "./serviceAccount";

describe("service-account entry point", () => {
  it.each([
    "TokenRefresher",
    "ClientCredentialsTokenSource",
    "retryDelayMs",
    "DEFAULT_REFRESH_AT_FRACTION",
    "DEFAULT_RETRY_BASE_MS",
    "DEFAULT_RETRY_MAX_MS",
  ])("exports %s", (name) => {
    expect(ServiceAccount).toHaveProperty(name);
  });

  // The main entry runs in the browser and must not load openid-client.
  it.each(["TokenRefresher", "ClientCredentialsTokenSource"])(
    "keeps %s out of the main entry point",
    (name) => {
      expect(LedgerPackage).not.toHaveProperty(name);
    },
  );
});
