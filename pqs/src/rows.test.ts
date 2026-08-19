import { toContract, toExercise, toSummaryRow } from "./rows.js";

describe("toContract", () => {
  it("maps snake_case columns, the JSONB payload, and the enrichment fields", () => {
    const contract = toContract<{ owner: string; amount: string }>({
      contract_id: "00abc",
      payload: { owner: "alice::1", amount: "10.0" },
      payload_type: "template",
      created_at_offset: "42", // int8 can arrive as a string
      created_effective_at: "2026-08-17T00:00:00Z",
      archived_at_offset: null,
      signatories: ["alice::1"],
      observers: [],
      witnesses: ["dso::1"],
      divulged_only: false,
      package_name: "c7lock-model",
      package_version: "0.2.5",
      metadata: null,
    });

    expect(contract.contractId).toBe("00abc");
    expect(contract.payload.amount).toBe("10.0");
    expect(contract.payloadType).toBe("template");
    expect(contract.createdAtOffset).toBe(42n);
    expect(contract.archivedAtOffset).toBeNull();
    expect(contract.packageName).toBe("c7lock-model");
    expect(contract.packageVersion).toBe("0.2.5");
    expect(contract.witnesses).toEqual(["dso::1"]);
    expect(contract.divulgedOnly).toBe(false);
    expect(contract.metadata).toBeNull();
  });
});

describe("toExercise", () => {
  it("maps the argument/result JSONB, acting parties, and package fields", () => {
    const exercise = toExercise<{ amount: string }, { round: number }>({
      contract_id: "00rules",
      template_fqn: "splice-amulet:Splice.AmuletRules:AmuletRules",
      choice: "AmuletRules_Transfer",
      choice_fqn: "splice-amulet:Splice.AmuletRules:AmuletRules:AmuletRules_Transfer",
      consuming: false, // AmuletRules_Transfer is nonconsuming
      argument: { amount: "5.0" },
      result: { round: 7 },
      exercised_at_offset: 100,
      exercised_effective_at: new Date("2026-08-17T00:00:00Z"),
      controllers: ["alice::1", "dso::1"],
      witnesses: [],
      package_name: "splice-amulet",
      package_version: "0.1.18",
    });

    expect(exercise.choice).toBe("AmuletRules_Transfer");
    expect(exercise.choiceFqn).toBe(
      "splice-amulet:Splice.AmuletRules:AmuletRules:AmuletRules_Transfer",
    );
    expect(exercise.consuming).toBe(false);
    expect(exercise.argument.amount).toBe("5.0");
    expect(exercise.result.round).toBe(7);
    expect(exercise.exercisedAtOffset).toBe(100n);
    expect(exercise.actingParties).toEqual(["alice::1", "dso::1"]);
    expect(exercise.packageVersion).toBe("0.1.18");
  });
});

describe("toSummaryRow", () => {
  it("keeps template_fqn and collects numeric count columns (incl. int8 strings)", () => {
    const row = toSummaryRow({
      template_fqn: "c7lock-model:C7Lock:Loan",
      creates: 12,
      archives: "3",
    });
    expect(row.templateFqn).toBe("c7lock-model:C7Lock:Loan");
    expect(row.counts).toEqual({ creates: 12, archives: 3 });
  });

  it("coerces bigint counts to number", () => {
    const row = toSummaryRow({ template_fqn: "X:Y:Z", count: 5n });
    expect(row.counts.count).toBe(5);
  });
});
