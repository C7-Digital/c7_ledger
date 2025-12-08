// Basic tests for the new ledger implementation
import { Ledger } from "./ledger";

// Valid JWT token for testing with sub field
// Header: {"alg":"HS256","typ":"JWT"}
// Payload: {"sub":"test-user","iat":1516239022}
const TEST_TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0ZXN0LXVzZXIiLCJpYXQiOjE1MTYyMzkwMjJ9.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";

describe("Ledger", () => {
  it("should create a ledger instance with default options", () => {
    const ledger = new Ledger({
      token: TEST_TOKEN,
      httpBaseUrl: "http://localhost:7575",
    });

    expect(ledger).toBeInstanceOf(Ledger);
  });

  it("should create a ledger instance with custom options", () => {
    const ledger = new Ledger({
      token: TEST_TOKEN,
      httpBaseUrl: "http://example.com:8080",
      wsBaseUrl: "ws://example.com:8080",
    });

    expect(ledger).toBeInstanceOf(Ledger);
  });
});
