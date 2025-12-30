/**
 * JWT token utilities for Canton ledger authentication
 */
import { decodeJwt } from "jose";
import { logger } from "./logger";

export interface TokenInfo {
  userId: string;
  expiresAt: number;
  issuedAt: number;
  isExpired: boolean;
  timeUntilExpiry: number;
}

/**
 * Decode and analyze a JWT token
 * @param token The JWT token string
 * @returns Token information including expiration details
 */
function analyzeToken(token: string): TokenInfo {
  const payload = decodeJwt(token);
  
  if (!payload.sub) {
    throw new Error("Token payload missing 'sub' field");
  }

  const now = Math.floor(Date.now() / 1000);
  const expiresAt = payload.exp || 0;
  const issuedAt = payload.iat || 0;
  const isExpired = expiresAt > 0 && expiresAt <= now;
  const timeUntilExpiry = expiresAt > 0 ? expiresAt - now : 0;

  return {
    userId: payload.sub,
    expiresAt,
    issuedAt,
    isExpired,
    timeUntilExpiry,
  };
}

/**
 * Log token expiration information
 * @param token The JWT token string
 * @param context Additional context for logging (e.g., "connection", "reconnection")
 */
export function logTokenExpiration(token: string, context: string = "token"): TokenInfo {
  try {
    const tokenInfo = analyzeToken(token);
    
    if (tokenInfo.isExpired) {
      logger.warn(`${context}: Token is EXPIRED`, {
        expiresAt: new Date(tokenInfo.expiresAt * 1000).toISOString(),
        expiredSecondsAgo: Math.abs(tokenInfo.timeUntilExpiry),
        userId: tokenInfo.userId,
      });
    } else if (tokenInfo.timeUntilExpiry < 300) { // Less than 5 minutes
      logger.warn(`${context}: Token expires soon`, {
        expiresAt: new Date(tokenInfo.expiresAt * 1000).toISOString(),
        secondsUntilExpiry: tokenInfo.timeUntilExpiry,
        userId: tokenInfo.userId,
      });
    } else {
      logger.debug(`${context}: Token is valid`, {
        expiresAt: new Date(tokenInfo.expiresAt * 1000).toISOString(),
        secondsUntilExpiry: tokenInfo.timeUntilExpiry,
        userId: tokenInfo.userId,
      });
    }
    return tokenInfo;
  } catch (error) {
    logger.error(`${context}: Failed to analyze token`, { error: error instanceof Error ? error.message : String(error) });
    return { userId: "", expiresAt: 0, issuedAt: 0, isExpired: true, timeUntilExpiry: 0 };
  }
}