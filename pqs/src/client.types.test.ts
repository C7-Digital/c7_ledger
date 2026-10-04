import type { ContractId } from "@daml/types";

import { PqsClient } from "./client.js";

// Compile-time checks: tsc and ts-jest fail this file if a plain string is
// accepted where a contract id is required.
describe("PqsClient contract-id inputs", () => {
  it("take a ContractId of any template, not a plain string", async () => {
    const client = new PqsClient({ connectionString: "postgres://unused" });
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
