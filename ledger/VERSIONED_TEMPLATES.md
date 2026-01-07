# Version-Aware Template Registry Usage

This document explains how to use the opt-in version-aware template registry feature in the Ledger API.

## Overview

The Ledger class now supports an optional `versionedRegistry` that allows you to work with multiple versions of DAML templates simultaneously. When enabled, `CreateEvent` objects will include version information that indicates whether a contract was created with the latest version or an older version. We rely on this to decode the interface view as well, and this is required for `queryInterface`.

## Configuration

### Step 1: Import the registry from codegen

```typescript
// Note: This example references a codegen package which is not part of @c7-digital/ledger
// You would need to generate or provide your own template registry
import { lookupTemplate, getCurrentPackageVersion } from "your-codegen-package";
```

### Step 2: Pass to Ledger constructor

```typescript
const ledger = new Ledger({
  token: authToken,
  httpBaseUrl: "https://api.example.com",
  // Opt-in to version-aware templates
  versionedRegistry: lookupTemplate,
});
```

## What You Get

When using the versioned template registry, all `CreateEvent` objects will include an optional `packageVersion` field:

```typescript
type CreateEvent<T extends object, K = unknown> = {
  type: "create";
  templateId: PackageIdString;
  contractId: ContractId<T>;
  payload: T;
  signatories: List<Party>;
  observers: List<Party>;
  key?: K;
  createdEventBlob: string;
  // New field when using versioned registry
  packageVersion?: string; // e.g., "0.0.6"
};
```

## Usage Example

```typescript
import { Ledger } from "@c7-digital/ledger";
import {
  lookupTemplate,
  getCurrentPackageVersion,
  InternetDomainName,
} from "your-codegen-package";

// Create ledger with version tracking
const ledger = new Ledger({
  token: process.env.AUTH_TOKEN!,
  httpBaseUrl: process.env.API_URL!,
  versionedRegistry: lookupTemplate,
});

// Stream contracts
const stream = await ledger.stream(InternetDomainName.DomainOwnershipToken, { offset: "0" });

// Get the current version for comparison
const currentVersion = getCurrentPackageVersion();

stream.on("create", event => {
  console.log(`Contract created: ${event.contractId}`);

  if (event.packageVersion) {
    console.log(`Package version: ${event.packageVersion}`);

    if (event.packageVersion !== currentVersion) {
      console.warn(`⚠️  Contract was created with older version ${event.packageVersion}`);
      console.warn(`   Consider upgrading to ${currentVersion}`);
      // Trigger upgrade workflow...
    }
  }
});
```

## Upgrade Detection

You can easily detect contracts that need upgrading by comparing versions:

```typescript
import { getCurrentPackageVersion } from "your-codegen-package";

async function findContractsNeedingUpgrade(ledger: Ledger) {
  const contracts = await ledger.query(InternetDomainName.DomainOwnershipToken);
  const currentVersion = getCurrentPackageVersion();

  const outdated = contracts.filter(c => c.packageVersion && c.packageVersion !== currentVersion);

  return outdated.map(c => ({
    contractId: c.contractId,
    currentVersion: c.packageVersion,
    latestVersion: currentVersion,
    payload: c.payload,
  }));
}
```

## Backward Compatibility

If you **don't** provide `versionedRegistry`, the Ledger class will:

- Use the default `lookupTemplate` from `@daml/types`
- The `packageVersion` field will be `undefined` in all `CreateEvent` objects
- Everything works exactly as before

## Benefits

1. **Version Awareness**: Know exactly which package version created each contract
2. **Upgrade Tracking**: Easily identify contracts that need upgrading by comparing with `getCurrentPackageVersion()`
3. **Multi-Version Support**: Work with contracts from different package versions simultaneously
4. **Opt-In**: Only pay the cost if you need the feature
5. **Decoupled**: The Ledger package doesn't need to know what "latest" means - you decide in your application logic

## How It Works

1. The `versionedRegistry` function returns `VersionedLookupResult` or `undefined`
2. The Ledger extracts the version string and stores it in `CreateEvent.packageVersion`
3. Your application code can compare this against `getCurrentPackageVersion()` to detect outdated contracts
4. This keeps the Ledger package simple and decoupled from version policy
