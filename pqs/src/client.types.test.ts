import type { ContractId } from "@daml/types";

import { PqsClient } from "./client.js";

// Compile-time checks: tsc and ts-jest fail this file if a plain string is
// accepted where a contract id is required.
describe("PqsClient contract-id inputs", () => {
  it("take a ContractId of any template, not a plain string", async () => {
    const client = new PqsClient({ kind: "connect", connectionString: "postgres://unused" });
    const typed = (cid: ContractId<{ owner: string }>) => {
      void client.lookupContract(cid);
      void client.lookupExercises(cid);
      // @ts-expect-error a plain string is not a ContractId
      void client.lookupContract("00abc");
      // @ts-expect-error a plain string is not a ContractId
      void client.lookupExercises("00abc");
    };
    expect(typeof typed).toBe("function");
    await client.close();
  });
});

describe("PqsClientConfig", () => {
  it("is exactly one connection source", () => {
    const configs = () => {
      // @ts-expect-error a config needs a source
      void new PqsClient({});
      // @ts-expect-error `connect` needs a connection string
      void new PqsClient({ kind: "connect" });
      // @ts-expect-error a `connect` config cannot also carry a shared instance
      void new PqsClient({ kind: "connect", connectionString: "x", sql: undefined });
    };
    expect(typeof configs).toBe("function");
  });
});
