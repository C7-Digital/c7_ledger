import { AdminClient } from "./client.js";

describe("AdminClient", () => {
  it("constructs with insecure default credentials", () => {
    const client = new AdminClient({ endpoint: "localhost:5002" });
    expect(client).toBeDefined();
  });

  it("constructs with explicit insecure tls", () => {
    const client = new AdminClient({ endpoint: "localhost:5002", tls: "insecure" });
    expect(client).toBeDefined();
  });

  it("constructs with optional bearer token", () => {
    const client = new AdminClient({
      endpoint: "localhost:5002",
      token: "test-admin-token",
    });
    expect(client).toBeDefined();
  });

  it("constructs with explicit deadline override", () => {
    const client = new AdminClient({
      endpoint: "localhost:5002",
      defaultDeadlineMs: 10_000,
    });
    expect(client).toBeDefined();
  });

  it("close() does not throw on a fresh client", async () => {
    const client = new AdminClient({ endpoint: "localhost:5002" });
    await expect(client.close()).resolves.toBeUndefined();
  });

  it("close() is idempotent", async () => {
    const client = new AdminClient({ endpoint: "localhost:5002" });
    await client.close();
    await expect(client.close()).resolves.toBeUndefined();
  });
});
