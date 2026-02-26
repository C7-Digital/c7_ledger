import type { AuthResult, ContractAuthPayload } from "./apiAuth.js";
import { decodeAuthPayload } from "./apiAuth.js";

/**
 * Extract auth payload from an HTTP request's Authorization header.
 * Works with any request object that has a `headers.authorization` property.
 */
export function getAuthPayloadFromRequest(req: { headers: { authorization?: string } }): AuthResult {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith("Bearer ")) {
    return {
      success: false,
      error:
        "Missing authorization header. Provide via Authorization: Bearer <base64-encoded-payload>",
    };
  }

  try {
    const encodedPayload = authHeader.slice(7); // Remove "Bearer "
    return decodeAuthPayload(encodedPayload);
  } catch (error) {
    return {
      success: false,
      error: "Invalid authorization payload format. Must be valid base64-encoded JSON.",
    };
  }
}

// Discriminant union types for contract auth validation
export type ContractAuthSuccess = {
  success: true;
  party: string;
};

export type ContractAuthFailure = {
  success: false;
  error: string;
  party?: string;
};

export type ContractAuthResult = ContractAuthSuccess | ContractAuthFailure;
