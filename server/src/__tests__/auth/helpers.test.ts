import { describe, it, expect } from "vitest";
import { getAuthPayloadFromRequest } from "../../auth/helpers.js";
import { createAdminAuth, createContractAuth } from "../../auth/apiAuth.js";

describe("getAuthPayloadFromRequest", () => {
  it("extracts a valid admin Bearer token", () => {
    const token = createAdminAuth("my-key");
    const req = { headers: { authorization: `Bearer ${token}` } };
    const result = getAuthPayloadFromRequest(req);

    expect(result).toEqual({
      success: true,
      data: { type: "admin", apiKey: "my-key" },
    });
  });

  it("extracts a valid contract Bearer token", () => {
    const token = createContractAuth("cid-123", "Alice");
    const req = { headers: { authorization: `Bearer ${token}` } };
    const result = getAuthPayloadFromRequest(req);

    expect(result).toEqual({
      success: true,
      data: { type: "contract", contractId: "cid-123", party: "Alice" },
    });
  });

  it("fails for missing authorization header", () => {
    const req = { headers: {} };
    const result = getAuthPayloadFromRequest(req);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Missing authorization header");
    }
  });

  it("fails for undefined authorization header", () => {
    const req = { headers: { authorization: undefined } };
    const result = getAuthPayloadFromRequest(req);

    expect(result.success).toBe(false);
  });

  it("fails for wrong prefix (Basic instead of Bearer)", () => {
    const token = createAdminAuth("key");
    const req = { headers: { authorization: `Basic ${token}` } };
    const result = getAuthPayloadFromRequest(req);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Missing authorization header");
    }
  });

  it("fails when no space after 'Bearer'", () => {
    const req = { headers: { authorization: "Bearertoken" } };
    const result = getAuthPayloadFromRequest(req);

    expect(result.success).toBe(false);
  });

  it("fails for invalid base64 payload", () => {
    const req = { headers: { authorization: "Bearer !!!invalid!!!" } };
    const result = getAuthPayloadFromRequest(req);

    expect(result.success).toBe(false);
  });

  it("fails for valid base64 with invalid payload schema", () => {
    const encoded = Buffer.from(
      JSON.stringify({ type: "bad" }),
      "utf-8"
    ).toString("base64");
    const req = { headers: { authorization: `Bearer ${encoded}` } };
    const result = getAuthPayloadFromRequest(req);

    expect(result.success).toBe(false);
  });
});
