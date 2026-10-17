import {
  toChoiceCountRow,
  toContract,
  toContractCountRow,
  toExercise,
  toUpdateCountRow,
} from "./rows.js";

describe("toContract", () => {
  it("rejects a row whose contract id is not a LedgerString", () => {
    expect(() =>
      toContract({ contract_id: "not a contract id!", payload: {} }),
    ).toThrow(/invalid contract id/);
  });

  it("maps snake_case columns, the JSONB payload, and the enrichment fields", () => {
    const contract = toContract<{ owner: string; amount: string }>({
      contract_id: "00abc",
      template_fqn: "example-model:Example:Coin",
      payload: { owner: "alice::1", amount: "10.0" },
      payload_type: "template",
      created_at_offset: "42", // int8 can arrive as a string
      created_effective_at: "2026-08-17T00:00:00Z",
      archived_at_offset: null,
      signatories: ["alice::1"],
      observers: [],
      witnesses: ["dso::1"],
      divulged_only: false,
      package_name: "example-model",
      package_version: "0.2.5",
      metadata: null,
    });

    expect(contract.contractId).toBe("00abc");
    expect(contract.templateFqn).toBe("example-model:Example:Coin");
    expect(contract.payload.amount).toBe("10.0");
    expect(contract.payloadType).toBe("template");
    expect(contract.createdAtOffset).toBe(42n);
    expect(contract.archivedAtOffset).toBeNull();
    expect(contract.packageName).toBe("example-model");
    expect(contract.packageVersion).toBe("0.2.5");
    expect(contract.witnesses).toEqual(["dso::1"]);
    expect(contract.divulgedOnly).toBe(false);
    expect(contract.metadata).toBeNull();
  });
});

describe("toContract on interface views", () => {
  it("names the interface each projection of one contract belongs to", () => {
    const base = {
      contract_id: "00coin",
      created_at_offset: "770",
      created_effective_at: "2026-10-16T00:00:00Z",
      archived_at_offset: null,
      payload: {},
    };
    const views = [
      { ...base, template_fqn: "splice-amulet:Splice.Amulet:Amulet", payload_type: "template" },
      {
        ...base,
        template_fqn: "splice-api-token-holding-v1:Splice.Api.Token.HoldingV1:Holding",
        payload_type: "interface",
      },
      {
        ...base,
        template_fqn: "splice-api-token-holding-v2:Splice.Api.Token.HoldingV2:Holding",
        payload_type: "interface",
      },
    ].map((row) => toContract(row));

    expect(views.map((v) => [v.templateFqn, v.payloadType])).toEqual([
      ["splice-amulet:Splice.Amulet:Amulet", "template"],
      ["splice-api-token-holding-v1:Splice.Api.Token.HoldingV1:Holding", "interface"],
      ["splice-api-token-holding-v2:Splice.Api.Token.HoldingV2:Holding", "interface"],
    ]);
  });
});

describe("toExercise", () => {
  it("rejects a template FQN or choice name in the wrong format", () => {
    const row = {
      contract_id: "00rules",
      template_fqn: "splice-amulet:Splice.AmuletRules:AmuletRules",
      choice: "AmuletRules_Transfer",
      exercised_at_offset: "1",
    };
    expect(() => toExercise({ ...row, template_fqn: "AmuletRules" })).toThrow(
      /Invalid IdentifierString/,
    );
    expect(() => toExercise({ ...row, choice: "Amulet Rules" })).toThrow(
      /Invalid NameString/,
    );
  });

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

describe("toContractCountRow", () => {
  it("rejects a template FQN in the wrong format", () => {
    expect(() =>
      toContractCountRow({ template_fqn: "not-a-template", payload_type: "template", count: 1 }),
    ).toThrow(/Invalid IdentifierString/);
  });

  it("keeps the payload type, so an interface view is told apart from its template", () => {
    const row = toContractCountRow({
      template_fqn: "splice-api-token-holding-v1:Splice.Api.Token.HoldingV1:Holding",
      payload_type: "interface",
      count: "118",
    });
    expect(row).toEqual({
      templateFqn: "splice-api-token-holding-v1:Splice.Api.Token.HoldingV1:Holding",
      payloadType: "interface",
      count: 118,
    });
  });

  it("reads an int8 count delivered as a bigint", () => {
    const row = toContractCountRow({ template_fqn: "X:Y:Z", payload_type: "template", count: 5n });
    expect(row.count).toBe(5);
  });

  it("rejects a count that is not a non-negative integer", () => {
    expect(() =>
      toContractCountRow({ template_fqn: "X:Y:Z", payload_type: "template", count: "abc" }),
    ).toThrow(/invalid count/);
    for (const bad of ["", " ", "1.5", "-1", "1e3"]) {
      expect(() =>
        toContractCountRow({ template_fqn: "X:Y:Z", payload_type: "template", count: bad }),
      ).toThrow(/invalid count/);
    }
  });
});

describe("toUpdateCountRow", () => {
  it("keeps the create and archive counts", () => {
    const row = toUpdateCountRow({
      template_fqn: "example-model:Example:Loan",
      payload_type: "template",
      creates: 12,
      archives: "3",
    });
    expect(row).toEqual({
      templateFqn: "example-model:Example:Loan",
      payloadType: "template",
      creates: 12,
      archives: 3,
    });
  });
});

describe("toChoiceCountRow", () => {
  it("keeps the choice, so two choices of one template stay apart", () => {
    const approve = toChoiceCountRow({
      template_fqn: "example-model:Example:Registration",
      choice_fqn: "example-model:Example:Registration:Approve",
      choice: "Approve",
      consuming: true,
      count: "78",
    });
    const reject = toChoiceCountRow({
      template_fqn: "example-model:Example:Registration",
      choice_fqn: "example-model:Example:Registration:Reject",
      choice: "Reject",
      consuming: true,
      count: "24",
    });
    expect(approve).toEqual({
      templateFqn: "example-model:Example:Registration",
      choice: "Approve",
      choiceFqn: "example-model:Example:Registration:Approve",
      consuming: true,
      count: 78,
    });
    expect(reject.choice).toBe("Reject");
    expect(reject.count).toBe(24);
  });

  it("keeps an interface choice under the interface that declares it", () => {
    const row = toChoiceCountRow({
      template_fqn: "splice-api-token-allocation-v1:Splice.Api.Token.AllocationV1:Allocation",
      choice_fqn:
        "splice-api-token-allocation-v1:Splice.Api.Token.AllocationV1:Allocation:Allocation_ExecuteTransfer",
      choice: "Allocation_ExecuteTransfer",
      consuming: "t",
      count: 48,
    });
    expect(row.templateFqn).toBe(
      "splice-api-token-allocation-v1:Splice.Api.Token.AllocationV1:Allocation",
    );
    expect(row.choice).toBe("Allocation_ExecuteTransfer");
    expect(row.consuming).toBe(true);
  });
});
