import { z } from "zod";

// Zod schemas for auth payloads
const adminAuthPayloadSchema = z
  .object({
    type: z.literal("admin"),
    apiKey: z.string().min(1, "API key cannot be empty"),
  })
  .strict();

const contractAuthPayloadSchema = z
  .object({
    type: z.literal("contract"),
    contractId: z.string().min(1, "Contract ID cannot be empty"),
    party: z.string().min(1, "Party cannot be empty"),
  })
  .strict();

// Discriminated union schema
const authPayloadSchema = z.discriminatedUnion("type", [
  adminAuthPayloadSchema,
  contractAuthPayloadSchema,
]);

// Type inference from Zod schema
export type AuthPayload = z.infer<typeof authPayloadSchema>;
export type AdminAuthPayload = z.infer<typeof adminAuthPayloadSchema>;
export type ContractAuthPayload = z.infer<typeof contractAuthPayloadSchema>;

// Result type for auth operations
export type AuthResult =
  | { success: true; data: AuthPayload }
  | { success: false; error: string };

// Export schemas for external validation if needed
export { authPayloadSchema, adminAuthPayloadSchema, contractAuthPayloadSchema };

/**
 * Validates and parses an auth payload object
 */
export function parseAuthPayload(rawPayload: unknown): AuthResult {
  const result = authPayloadSchema.safeParse(rawPayload);
  if (result.success) {
    return { success: true, data: result.data };
  } else {
    const errors = result.error.errors.map(
      (err) => `${err.path.join(".")}: ${err.message}`
    );
    return { success: false, error: `Validation failed: ${errors.join(", ")}` };
  }
}

/**
 * Browser-compatible base64 encoding
 */
function base64Encode(str: string): string {
  if (typeof btoa !== "undefined") {
    return btoa(str);
  } else {
    return Buffer.from(str, "utf-8").toString("base64");
  }
}

/**
 * Browser-compatible base64 decoding
 */
function base64Decode(str: string): string {
  if (typeof atob !== "undefined") {
    return atob(str);
  } else {
    return Buffer.from(str, "base64").toString("utf-8");
  }
}

/**
 * Encodes an auth payload to base64
 */
export function encodeAuthPayload(payload: AuthPayload): string {
  const validatedPayload = authPayloadSchema.parse(payload);
  const jsonString = JSON.stringify(validatedPayload);
  return base64Encode(jsonString);
}

/**
 * Decodes and validates a base64-encoded auth payload
 */
export function decodeAuthPayload(encodedPayload: string): AuthResult {
  try {
    const decoded = base64Decode(encodedPayload);
    const rawPayload = JSON.parse(decoded);
    return parseAuthPayload(rawPayload);
  } catch (error) {
    if (error instanceof Error) {
      return { success: false, error: `Decode failed: ${error.message}` };
    }
    return { success: false, error: "Decode failed: Unknown error" };
  }
}

/**
 * Helper function to create admin authentication token
 */
export function createAdminAuth(apiKey: string): string {
  const payload: AdminAuthPayload = { type: "admin", apiKey };
  return encodeAuthPayload(payload);
}

/**
 * Helper function to create contract-based authentication token
 */
export function createContractAuth(contractId: string, party: string): string {
  const payload: ContractAuthPayload = { type: "contract", contractId, party };
  return encodeAuthPayload(payload);
}

/**
 * Type guards for auth payload types
 */
export function isAdminAuth(payload: AuthPayload): payload is AdminAuthPayload {
  return payload.type === "admin";
}

export function isContractAuth(
  payload: AuthPayload
): payload is ContractAuthPayload {
  return payload.type === "contract";
}
