// Basic tests for the new ledger implementation
import { Ledger } from "./ledger";

describe("Ledger", () => {
  it("should create a ledger instance with default options", () => {
    const ledger = new Ledger({
      token: "test-token",
      httpBaseUrl: "http://localhost:7575",
    });

    expect(ledger).toBeInstanceOf(Ledger);
  });

  it("should create a ledger instance with custom options", () => {
    const ledger = new Ledger({
      token: "test-token",
      httpBaseUrl: "http://example.com:8080",
      wsBaseUrl: "ws://example.com:8080",
    });

    expect(ledger).toBeInstanceOf(Ledger);
  });
});
