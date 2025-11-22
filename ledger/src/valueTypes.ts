// Branded string types based on value.proto from Daml gRPC API
// Source: https://github.com/digital-asset/daml/blob/main/sdk/daml-lf/ledger-api-value/src/main/protobuf/com/daml/ledger/api/v2/value.proto

// Branded types for compile-time safety
declare const __brand: unique symbol;
type Brand<T, TBrand> = T & { [__brand]: TBrand };

// String format types from value.proto
export type NameString = Brand<string, "NameString">;
export type PackageIdString = Brand<string, "PackageIdString">;
export type PartyIdString = Brand<string, "PartyIdString">;
export type LedgerString = Brand<string, "LedgerString">;
export type UserIdString = Brand<string, "UserIdString">;

// Validation patterns from value.proto
const NAME_STRING_PATTERN = /^[A-Za-z\$_][A-Za-z0-9\$_]*$/;
const PACKAGE_ID_STRING_PATTERN = /^[A-Za-z0-9\-_ ]+$/;
const PARTY_ID_STRING_PATTERN = /^[A-Za-z0-9:\-_ ]+$/;
const LEDGER_STRING_PATTERN = /^[A-Za-z0-9#:\-_/ ]+$/;
const USER_ID_STRING_PATTERN = /^[a-zA-Z0-9@^$.!\`\-#+'~_|:]+$/;

// Length constraints from value.proto
const MAX_NAME_STRING_LENGTH = 1000;
const MAX_PACKAGE_ID_STRING_LENGTH = 64;
const MAX_PARTY_ID_STRING_LENGTH = 255;
const MAX_LEDGER_STRING_LENGTH = 255;
const MAX_USER_ID_STRING_LENGTH = 128;

// Validation functions
export function isValidNameString(value: string): value is NameString {
  return value.length <= MAX_NAME_STRING_LENGTH && NAME_STRING_PATTERN.test(value);
}

export function isValidPackageIdString(value: string): value is PackageIdString {
  return value.length <= MAX_PACKAGE_ID_STRING_LENGTH && PACKAGE_ID_STRING_PATTERN.test(value);
}

export function isValidPartyIdString(value: string): value is PartyIdString {
  return value.length <= MAX_PARTY_ID_STRING_LENGTH && PARTY_ID_STRING_PATTERN.test(value);
}

export function isValidLedgerString(value: string): value is LedgerString {
  return value.length <= MAX_LEDGER_STRING_LENGTH && LEDGER_STRING_PATTERN.test(value);
}

export function isValidUserIdString(value: string): value is UserIdString {
  return value.length <= MAX_USER_ID_STRING_LENGTH && USER_ID_STRING_PATTERN.test(value);
}

// Creation functions with validation
export function createNameString(value: string): NameString {
  if (!isValidNameString(value)) {
    throw new Error(
      `Invalid NameString: "${value}". Must match [A-Za-z\$_][A-Za-z0-9\$_]* and be ≤ ${MAX_NAME_STRING_LENGTH} chars`
    );
  }
  return value as NameString;
}

export function createPackageIdString(value: string): PackageIdString {
  if (!isValidPackageIdString(value)) {
    throw new Error(
      `Invalid PackageIdString: "${value}". Must match [A-Za-z0-9\-_ ]+ and be ≤ ${MAX_PACKAGE_ID_STRING_LENGTH} chars`
    );
  }
  return value as PackageIdString;
}

export function createPartyIdString(value: string): PartyIdString {
  if (!isValidPartyIdString(value)) {
    throw new Error(
      `Invalid PartyIdString: "${value}". Must match [A-Za-z0-9:\-_ ]+ and be ≤ ${MAX_PARTY_ID_STRING_LENGTH} chars`
    );
  }
  return value as PartyIdString;
}

export function createLedgerString(value: string): LedgerString {
  if (!isValidLedgerString(value)) {
    throw new Error(
      `Invalid LedgerString: "${value}". Must match [A-Za-z0-9#:\-_/ ]+ and be ≤ ${MAX_LEDGER_STRING_LENGTH} chars`
    );
  }
  return value as LedgerString;
}

export function createUserIdString(value: string): UserIdString {
  if (!isValidUserIdString(value)) {
    throw new Error(
      `Invalid UserIdString: "${value}". Must match [a-zA-Z0-9@^$.!\`\-#+'~_|:]+ and be ≤ ${MAX_USER_ID_STRING_LENGTH} chars`
    );
  }
  return value as UserIdString;
}

// Utility type guards for runtime checking
export const ValueStringValidators = {
  isValidNameString,
  isValidPackageIdString,
  isValidPartyIdString,
  isValidLedgerString,
  isValidUserIdString,
} as const;

export const ValueStringCreators = {
  createNameString,
  createPackageIdString,
  createPartyIdString,
  createLedgerString,
  createUserIdString,
} as const;
