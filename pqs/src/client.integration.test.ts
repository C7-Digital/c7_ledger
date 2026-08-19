/**
 * End-to-end check against a live PQS. Gated on PQS_TEST_URL so unit CI skips
 * it; run it against the c7lock LocalNet PQS (`just local::pqs-up`), e.g.:
 *
 *   PQS_TEST_URL=postgresql://cnadmin:supersafe@localhost:5432/pqs \
 *     pnpm --filter @c7-digital/pqs test
 */

import { PqsClient } from "./client.js";
import { choiceName, templateName } from "./identifiers.js";

const url = process.env.PQS_TEST_URL;
const describeLive = url ? describe : describe.skip;

describeLive("PqsClient (live PQS)", () => {
  const client = new PqsClient({ connectionString: url });

  afterAll(async () => {
    await client.close();
  });

  it("reads active Amulet contracts", async () => {
    const amulets = await client.active(
      templateName("splice-amulet:Splice.Amulet:Amulet"),
    );
    expect(Array.isArray(amulets)).toBe(true);
  });

  it("reads AmuletRules_Transfer exercises (proves TransactionTreeStream)", async () => {
    const transfers = await client.exercises(
      choiceName("splice-amulet:Splice.AmuletRules:AmuletRules:AmuletRules_Transfer"),
    );
    expect(Array.isArray(transfers)).toBe(true);
    for (const t of transfers) {
      expect(t.choice).toBe("AmuletRules_Transfer");
    }
  });

  it("returns per-template active counts", async () => {
    const summary = await client.summaryActive();
    expect(Array.isArray(summary)).toBe(true);
    for (const row of summary) {
      expect(typeof row.templateFqn).toBe("string");
    }
  });

  it("reports the latest and pruned offsets", async () => {
    const latest = await client.latestOffset();
    const pruned = await client.prunedOffset();
    expect(latest === null || typeof latest === "bigint").toBe(true);
    expect(pruned === null || typeof pruned === "bigint").toBe(true);
  });
});
