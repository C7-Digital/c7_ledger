# Ledger Build 

A standalone, repeatable build system for generating TypeScript types from OpenAPI and AsyncAPI specifications with value.proto branding.

## Features

- **SDK Version Targeting**: Generate types for specific Daml SDK versions
- **Auto-Discovery**: Automatically find the latest specification files
- **In-Place Branding**: Apply value.proto constraints to generated types
- **Parallel Processing**: Optimize build performance with concurrent operations
- **Schema Embedding**: Include YAML schemas for runtime validation
- **Portable**: No hardcoded paths, works as standalone package

## Usage

### As NPM Script

```bash
pnpm build                           # Use configured SDK version
pnpm build -- --sdk-version=3.4.0   # Override SDK version
```

### As Standalone Binary

```bash
pnpm exec ledger-build                        # Auto-discover latest specs
pnpm exec ledger-build --sdk-version=3.4.0    # Target specific SDK version
```

### Programmatic Usage

```typescript
import { build } from "@c7/ledger/scripts/build";

await build();
```

## Required Dependencies

The build system requires these development dependencies:

```json
{
  "devDependencies": {
    "openapi-typescript": "^7.4.2",
    "tsc-alias": "^1.8.16",
    "tsx": "^4.11.0",
    "typescript": "^5.8.3",
    "yaml": "^2.8.1"
  }
}
```

## Directory Structure

### Input

```
specs/
├── openapi_{SDK_VERSION}.yaml
└── asyncapi_{SDK_VERSION}.yaml
```

### Output

```
src/generated/
├── api.ts              # OpenAPI types (branded)
├── async-api.ts        # AsyncAPI types (branded)
├── asyncapi-schema.ts  # Embedded AsyncAPI YAML
├── openapi-schema.ts   # Embedded OpenAPI YAML
└── sdk-version.ts      # SDK version constant
```

## Branding

The build system automatically applies value.proto constraints to string fields:

- `LedgerString` for contract/update/command IDs
- `PartyIdString` for party identifiers
- `UserIdString` for user identifiers
- `NameString` for choice names
- `PackageIdString` for template/package identifiers

## Standalone Package Usage

To use this build system in other projects:

1. **Install the package**:

   ```bash
   pnpm install @c7/ledger
   ```

2. **Add to package.json**:

   ```json
   {
     "scripts": {
       "generate-types": "pnpm exec ledger-build --sdk-version=3.4.0"
     }
   }
   ```

3. **Create spec directory structure**:

   ```
   specs/
   ├── openapi_3.4.0.yaml
   └── asyncapi_3.4.0.yaml
   ```

4. **Run the build**:
   ```bash
   pnpm run generate-types
   ```

## Environment Variables

- `SDK_VERSION`: Default SDK version (overridden by --sdk-version)

## Exit Codes

- `0`: Success
- `1`: Build failure (missing specs, compilation errors, etc.
