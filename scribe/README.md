# @c7-digital/scribe

Transform raw DAML codegen output into unified, modern ESM TypeScript packages for use with `@c7-digital/ledger`.

## What it does

`dpm codegen-js` produces raw TypeScript/CommonJS packages -- one per DAR -- with global template registration, mixed import conventions, and self-referencing type imports. Scribe absorbs all of that complexity:

- **CJS to ESM**: bundles CommonJS `require()`/`module.exports` into clean ESM `import`/`export` via Rollup
- **Global registry bypass**: strips `damlTypes.registerTemplate()` side-effects, replaces them with a version-aware registry
- **Import fixups**: rewrites `@mojotech/json-type-validation` (default -> namespace), `@daml/types` (default -> namespace), strips `@daml/ledger` side-effect imports
- **Package unification**: merges multiple DAR packages into a single entry point with named exports
- **Self-reference resolution**: resolves `.d.ts` self-referencing imports (e.g. `@mypackage/codegen/daml-prim-DA-Types-1.0.0`) to local paths
- **Version-aware registry**: generates a `versionedRegistry` function that conforms to `VersionedRegistry` from `@c7-digital/ledger`

## Install

```bash
pnpm add -D @c7-digital/scribe
```

## Quick start

### Zero-config

Point scribe at the raw `dpm codegen-js` output:

```bash
pnpm exec scribe -i ./codegen/js
```

Scribe auto-detects:

| What | How |
|------|-----|
| Main package | The non-`daml-prim`/`daml-stdlib`/`splice-*` package |
| Modules | Every directory under `lib/` |
| Templates & interfaces | Exports with `templateId` in `.d.ts` files |
| Package ID | From `lib/index.d.ts` |
| Version | From directory name (e.g. `my-project-0.1.0` -> `0.1.0`) |
| Vendor packages | `splice-*` packages (third-party DARs your model depends on; exported separately from your main modules) |
| Stdlib | `daml-prim-*`, `daml-stdlib-*`, `ghc-stdlib-*` |

Output:

```
dist/
├── codegen.js        # Bundled ESM (all modules + registry)
├── index.js          # Re-exports from codegen.js
├── index.d.ts        # TypeScript declarations
├── version.js        # PACKAGE_VERSION export
└── version.d.ts      # Version type declaration
```

### With config

For projects that need aliases, selective exports, or compat versions, create a `scribe.yaml`:

```yaml
schema: "1.0"
input: "../../codegen/js"

main:
  pattern: "domain-verification-model-*"

vendor:
  "splice-amulet-*":
    modules:
      "Splice.Amulet":
        alias: Splice_Amulet
        templates:
          - FeaturedAppActivityMarker

compat:
  versions:
    - hash: "8afd289e3ba826fcb23d955cfc108470b53527b0615745554185e5c9625b5832"
      version: "0.0.5"
```

```bash
pnpm exec scribe --config scribe.yaml
```

## CLI

```
scribe [options]

Options:
  -i, --input <path>     Path to codegen/js directory (default: ./codegen/js)
  -c, --config <path>    Path to scribe.yaml config file
  -v, --version <ver>    Override package version
  -o, --output <path>    Output directory (default: dist)
  --dry-run              Preview without writing files
```

**Version resolution priority**: `--version` flag > `$DAR_VERSION` env var > directory name.

## Config reference

All fields are optional except `schema`.

```yaml
schema: "1.0"                  # Required. Config schema version.

input: "./codegen/js"          # Path to raw codegen output.
                               # Default: ./codegen/js

output:
  dir: "dist"                  # Output directory. Default: dist
  bundle: true                 # Run CJS->ESM bundling. Default: true

main:
  pattern: "my-project-*"     # Glob to identify the main package.
                               # Only needed when auto-detection is ambiguous.

  modules:                     # Restrict which modules are exported.
                               # Omit to export all discovered modules.
    MyModule:
      templates:               # Restrict which templates are registered.
        - MyTemplate           # Omit to register all.
      interfaces:
        - MyInterface
      alias: CustomName        # Override the export name.
    OtherModule: {}            # All templates/interfaces in this module.

vendor:
  "splice-amulet-*":          # Glob pattern matching vendor package names.
    modules:
      "Splice.Amulet":
        alias: Splice_Amulet  # Export alias.
        templates:
          - FeaturedAppActivityMarker

compat:
  versions:                    # Backward-compat hashes for contract upgrades.
    - hash: "8afd289e..."      # Package ID hash from a previous version.
      version: "0.0.5"         # Version label for that hash.
```

**The config exists to constrain, not to describe.** If you omit `modules`, all are exported. If you omit `templates`, all are registered. Use config when you want *less* than the default, or need aliases and compat hashes.

### Multi-version main packages

When `codegen/js` contains multiple versions of the main package (e.g. `model-0.0.7`, `model-0.0.8`, `model-0.0.9`), scribe selects one:

1. If `--version` or `$DAR_VERSION` is set, use that version
2. Otherwise, pick the latest by semver

Non-selected versions are demoted to stdlib (bundled as dependencies but not exported).

### Vendor filtering

When a `vendor` section is present, only `splice-*` packages matching a vendor pattern are included. Unmatched `splice-*` packages are excluded (demoted to stdlib). Without a `vendor` section, all `splice-*` packages are included as vendors.

## Vite plugin

Scribe ships a companion Vite plugin for consumer apps at `@c7-digital/scribe/vite`. This handles the runtime concerns that can't be solved at build time -- `@daml/types` and `@mojotech/json-type-validation` need special resolution in the consumer's dev server and build.

```typescript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { damlCodegenPlugin } from '@c7-digital/scribe/vite';

export default defineConfig({
  plugins: [
    damlCodegenPlugin(),
    react(),
  ],
});
```

### What `damlCodegenPlugin()` configures

- `@mojotech/json-type-validation` -> UMD build (required for ESM compat)
- `@daml/types` -> local node_modules copy
- `optimizeDeps` for `@daml/types`, `@c7-digital/ledger`, `@c7-digital/react`, and transitive deps

### Options

```typescript
damlCodegenPlugin({
  // Override node_modules lookup path.
  // Useful in monorepos where node_modules isn't at cwd().
  nodeModulesPath: __dirname,
})
```

The plugin is independent of scribe's CLI -- it works for any app that imports `@daml/types`, even without using scribe for codegen.

## Programmatic API

```typescript
import { run, loadConfig, discoverPackages, analyzePackage, generate } from '@c7-digital/scribe';

// Run the full pipeline
await run({ input: './codegen/js' });

// Or use individual steps
const config = await loadConfig({ config: './scribe.yaml' });
const packages = await discoverPackages(config);
const analyzed = await Promise.all(
  packages.map(pkg => analyzePackage(pkg, config))
);
await generate(analyzed, config);
```

## Generated output

### Exports

Scribe generates named exports for each module and a flat `versionedRegistry`:

```typescript
// Main package modules
import { InternetDomainName, AddressBook, C7Credentials } from '@mypackage/codegen';

// Vendor modules (with aliases from config)
import { Splice_Amulet } from '@mypackage/codegen';

// Registry (conforms to VersionedRegistry from @c7-digital/ledger)
import { versionedRegistry, PACKAGE_VERSION } from '@mypackage/codegen';
```

### Using with `@c7-digital/ledger`

```typescript
import { Ledger } from '@c7-digital/ledger';
import { versionedRegistry, InternetDomainName } from '@mypackage/codegen';

const ledger = new Ledger({
  url: 'http://localhost:7575',
  token: authToken,
  versionedRegistry,  // plugs directly into ledger
});

const domains = await ledger.query(InternetDomainName.DomainOwnershipToken, {
  owner: myParty,
});
```

The `versionedRegistry` function is structurally compatible with `VersionedRegistry` from `@c7-digital/ledger` without a hard import dependency. TypeScript accepts it wherever `VersionedRegistry` is expected.

## How it works

### Pipeline

1. **Load config** -- read `scribe.yaml` (if provided), merge with CLI flags and defaults
2. **Discover** -- scan input directory, classify packages as main/vendor/stdlib
3. **Analyze** -- extract `packageId`, modules, templates, and interfaces from each package's `.d.ts` files
4. **Generate** -- produce `index.js` (imports, exports, registry), `index.d.ts`, `version.js`, `version.d.ts`
5. **Bundle** -- Vite/Rollup build: CJS->ESM, import fixups, `registerTemplate` stripping, self-reference resolution

### Architecture

```
dpm codegen-js          scribe                    consumer app
┌─────────────┐    ┌──────────────────┐    ┌──────────────────────┐
│ model-0.0.8/│    │ discover         │    │ vite.config.ts       │
│ splice-*/   │--->│ analyze          │    │   damlCodegenPlugin()       │
│ daml-prim-*/│    │ generate + bundle│--->│                      │
│ daml-stdlib/│    │                  │    │ import { ... }        │
└─────────────┘    └──────────────────┘    │   from '@pkg/codegen'│
                                           └──────────────────────┘
```

Scribe owns the **build** side (raw codegen -> clean ESM bundle). The `damlCodegenPlugin()` Vite plugin owns the **consumer** side (`@daml/types` resolution, optimizeDeps). Neither depends on the other.

## Consumer `package.json` setup

```json
{
  "name": "@mypackage/codegen",
  "version": "0.0.1",
  "type": "module",
  "main": "dist/index.js",
  "types": "src/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./src/index.d.ts"
    },
    "./version": {
      "import": "./dist/version.js",
      "types": "./src/version.d.ts"
    }
  },
  "scripts": {
    "build": "scribe --config scribe.yaml",
    "prepare": "scribe --config scribe.yaml"
  },
  "dependencies": {
    "@daml/types": "3.4.9",
    "@mojotech/json-type-validation": "^3.1.0"
  },
  "devDependencies": {
    "@c7-digital/scribe": "^0.0.1"
  }
}
```

Scribe creates a `src/` staging directory (symlinked raw codegen packages + generated `.d.ts` files) and a `dist/` directory (bundled ESM). The `types` field points at `src/index.d.ts` so TypeScript resolves types through the original `.d.ts` chain, while `main`/`exports` point at the bundled `dist/` output for runtime.

## Requirements

- Node.js >= 18.0.0
- pnpm >= 8.0.0
- Vite 5.x or 6.x (optional, for bundling and the companion plugin)
