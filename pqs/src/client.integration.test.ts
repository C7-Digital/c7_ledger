/**
 * End-to-end check against a live PQS. Gated on PQS_TEST_URL so unit CI skips
 * it; run it against a LocalNet PQS, e.g.:
 *
 *   PQS_TEST_URL=postgresql://cnadmin:supersafe@localhost:5432/pqs \
 *     pnpm --filter @c7-digital/pqs test
 */

import { PqsClient } from "./client.js";
import { choiceName, templateName } from "./identifiers.js";

const url = process.env.PQS_TEST_URL ?? "";
const describeLive = url ? describe : describe.skip;

describeLive("PqsClient (live PQS)", () => {
  const client = new PqsClient({ kind: "connect", connectionString: url });

  afterAll(async () => {
    await client.close();
  });

  it("reads active contracts at the head when no offset is given", async () => {
    const amulet = templateName("splice-amulet:Splice.Amulet:Amulet");
    const latest = await client.latestOffset();
    expect(latest).not.toBeNull();
    const atHead = await client.active(amulet, { atOffset: latest! });
    const byDefault = await client.active(amulet);
    expect(atHead.length).toBeGreaterThan(0);
    expect(byDefault.length).toBe(atHead.length);
  });

  it("reads the whole ingested range when no bounds are given", async () => {
    const amulet = templateName("splice-amulet:Splice.Amulet:Amulet");
    const creates = await client.creates(amulet);
    expect(creates.length).toBeGreaterThan(0);
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

  it("returns active counts per template and per interface view", async () => {
    const summary = await client.summaryActive();
    expect(summary.length).toBeGreaterThan(0);
    for (const row of summary) {
      expect(typeof row.templateFqn).toBe("string");
      expect(Number.isSafeInteger(row.count)).toBe(true);
    }
    const holding = summary.find(
      (r) => r.templateFqn === "splice-api-token-holding-v1:Splice.Api.Token.HoldingV1:Holding",
    );
    expect(holding?.payloadType).toBe("interface");
  });

  it("returns one exercise count per choice, interface choices included", async () => {
    const summary = await client.summaryExercises();
    const keys = summary.map((r) => r.choiceFqn);
    expect(new Set(keys).size).toBe(keys.length);
    expect(summary.some((r) => r.choice === "AmuletRules_Transfer")).toBe(true);
  });

  it("returns create and archive counts per template", async () => {
    const summary = await client.summaryUpdates();
    expect(summary.length).toBeGreaterThan(0);
    for (const row of summary) {
      expect(Number.isSafeInteger(row.creates)).toBe(true);
      expect(Number.isSafeInteger(row.archives)).toBe(true);
    }
  });

  it("names the template and each interface view of one contract", async () => {
    const [amulet] = await client.active(templateName("splice-amulet:Splice.Amulet:Amulet"));
    expect(amulet).toBeDefined();
    expect(amulet!.templateFqn).toBe("splice-amulet:Splice.Amulet:Amulet");
    const views = await client.lookupContract(amulet!.contractId);
    const byFqn = new Map<string, string>(views.map((v) => [v.templateFqn, v.payloadType]));
    expect(byFqn.get("splice-amulet:Splice.Amulet:Amulet")).toBe("template");
    expect(byFqn.get("splice-api-token-holding-v1:Splice.Api.Token.HoldingV1:Holding")).toBe(
      "interface",
    );
  });

  it("reports the latest and pruned offsets", async () => {
    const latest = await client.latestOffset();
    const pruned = await client.prunedOffset();
    expect(latest === null || typeof latest === "bigint").toBe(true);
    expect(pruned === null || typeof pruned === "bigint").toBe(true);
  });
});
