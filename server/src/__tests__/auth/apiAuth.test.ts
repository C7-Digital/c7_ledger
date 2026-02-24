import { describe, it, expect } from "vitest";
import {
  parseAuthPayload,
  encodeAuthPayload,
  decodeAuthPayload,
  createAdminAuth,
  createContractAuth,
  isAdminAuth,
  isContractAuth,
  type AuthPayload,
  type AdminAuthPayload,
  type ContractAuthPayload,
} from "../../auth/apiAuth.js";

describe("parseAuthPayload", () => {
  it("parses a valid admin payload", () => {
    const result = parseAuthPayload({ type: "admin", apiKey: "my-key" });
    expect(result).toEqual({
      success: true,
      data: { type: "admin", apiKey: "my-key" },
    });
  });

  it("parses a valid contract payload", () => {
    const result = parseAuthPayload({
      type: "contract",
      contractId: "cid-123",
      party: "Alice",
    });
    expect(result).toEqual({
      success: true,
      data: { type: "contract", contractId: "cid-123", party: "Alice" },
    });
  });

  it("rejects empty apiKey", () => {
    const result = parseAuthPayload({ type: "admin", apiKey: "" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("API key cannot be empty");
    }
  });

  it("rejects empty contractId", () => {
    const result = parseAuthPayload({
      type: "contract",
      contractId: "",
      party: "Alice",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Contract ID cannot be empty");
    }
  });

  it("rejects empty party", () => {
    const result = parseAuthPayload({
      type: "contract",
      contractId: "cid-123",
      party: "",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Party cannot be empty");
    }
  });

  it("rejects extra fields (strict mode)", () => {
    const result = parseAuthPayload({
      type: "admin",
      apiKey: "key",
      extra: "field",
    });
    expect(result.success).toBe(false);
  });

  it("rejects null", () => {
    const result = parseAuthPayload(null);
    expect(result.success).toBe(false);
  });

  it("rejects undefined", () => {
    const result = parseAuthPayload(undefined);
    expect(result.success).toBe(false);
  });

  it("rejects unknown type", () => {
    const result = parseAuthPayload({ type: "unknown", data: "value" });
    expect(result.success).toBe(false);
  });

  it("returns descriptive error messages", () => {
    const result = parseAuthPayload({ type: "admin" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Validation failed");
    }
  });
});

describe("encodeAuthPayload / decodeAuthPayload", () => {
  it("round-trips an admin payload", () => {
    const payload: AdminAuthPayload = { type: "admin", apiKey: "secret-key" };
    const encoded = encodeAuthPayload(payload);
    const decoded = decodeAuthPayload(encoded);

    expect(decoded).toEqual({ success: true, data: payload });
  });

  it("round-trips a contract payload", () => {
    const payload: ContractAuthPayload = {
      type: "contract",
      contractId: "cid-abc",
      party: "Bob",
    };
    const encoded = encodeAuthPayload(payload);
    const decoded = decodeAuthPayload(encoded);

    expect(decoded).toEqual({ success: true, data: payload });
  });

  it("returns failure for invalid base64", () => {
    const result = decodeAuthPayload("!!!not-base64!!!");
    expect(result.success).toBe(false);
  });

  it("returns failure for valid base64 with invalid JSON", () => {
    const encoded = Buffer.from("not json", "utf-8").toString("base64");
    const result = decodeAuthPayload(encoded);
    expect(result.success).toBe(false);
  });

  it("returns failure for valid JSON that doesn't match schema", () => {
    const encoded = Buffer.from(
      JSON.stringify({ type: "bad", foo: "bar" }),
      "utf-8"
    ).toString("base64");
    const result = decodeAuthPayload(encoded);
    expect(result.success).toBe(false);
  });
});

describe("createAdminAuth / createContractAuth", () => {
  it("creates and decodes admin auth", () => {
    const encoded = createAdminAuth("my-api-key");
    const decoded = decodeAuthPayload(encoded);

    expect(decoded).toEqual({
      success: true,
      data: { type: "admin", apiKey: "my-api-key" },
    });
  });

  it("creates and decodes contract auth", () => {
    const encoded = createContractAuth("cid-xyz", "Charlie");
    const decoded = decodeAuthPayload(encoded);

    expect(decoded).toEqual({
      success: true,
      data: { type: "contract", contractId: "cid-xyz", party: "Charlie" },
    });
  });

  it("preserves all values through round-trip", () => {
    const contractId = "00abcd1234567890abcdef";
    const party = "party::namespace";
    const encoded = createContractAuth(contractId, party);
    const decoded = decodeAuthPayload(encoded);

    expect(decoded.success).toBe(true);
    if (decoded.success) {
      expect(decoded.data).toEqual({
        type: "contract",
        contractId,
        party,
      });
    }
  });
});

describe("isAdminAuth / isContractAuth", () => {
  it("correctly identifies admin auth", () => {
    const payload: AuthPayload = { type: "admin", apiKey: "key" };
    expect(isAdminAuth(payload)).toBe(true);
    expect(isContractAuth(payload)).toBe(false);
  });

  it("correctly identifies contract auth", () => {
    const payload: AuthPayload = {
      type: "contract",
      contractId: "cid",
      party: "Alice",
    };
    expect(isAdminAuth(payload)).toBe(false);
    expect(isContractAuth(payload)).toBe(true);
  });

  it("narrows type correctly for admin", () => {
    const payload: AuthPayload = { type: "admin", apiKey: "key" };
    if (isAdminAuth(payload)) {
      // TypeScript should allow accessing apiKey here
      expect(payload.apiKey).toBe("key");
    }
  });

  it("narrows type correctly for contract", () => {
    const payload: AuthPayload = {
      type: "contract",
      contractId: "cid",
      party: "Alice",
    };
    if (isContractAuth(payload)) {
      // TypeScript should allow accessing contractId and party here
      expect(payload.contractId).toBe("cid");
      expect(payload.party).toBe("Alice");
    }
  });
});
