# Getting Started with @c7/ledger

This guide will help you set up and start using the @c7/ledger package.

## Prerequisites

- Node.js >= 18.0.0
- pnpm >= 8.0.0

## Installation

### For Development

```bash
pnpm install
```

### Building the Package

```bash
pnpm build
```

This will:
1. Fetch the Canton OpenAPI and AsyncAPI specifications
2. Generate TypeScript types
3. Compile the TypeScript code to JavaScript
4. Output to the `lib/` and `lib-lite/` directories

## Development Workflow

### Clean Build Artifacts

Remove all generated files and build outputs:

```bash
pnpm clean
```

This removes:
- `lib/` - Compiled JavaScript and type definitions
- `lib-lite/` - Compiled lite version
- `src/generated/` - Auto-generated TypeScript types

### Watch Mode

For continuous development with automatic recompilation:

```bash
pnpm watch
```

### Running Tests

```bash
pnpm test
```

### Linting

```bash
pnpm lint
```

### Full Clean + Rebuild

```bash
pnpm clean && pnpm build
```

## Usage in Other Projects

After building, you can use this package in other projects:

### Option 1: Publish to npm

```bash
# Update version in package.json
pnpm version patch  # or minor, major

# Publish
pnpm publish
```

### Option 2: Link Locally

```bash
# In this package directory
pnpm link --global

# In your project directory
pnpm link --global @c7/ledger
```

### Option 3: Use as File Dependency

In your project's `package.json`:

```json
{
  "dependencies": {
    "@c7/ledger": "file:../c7_ledger"
  }
}
```

## Project Structure

```
c7_ledger/
├── src/              # Source TypeScript files
│   ├── generated/   # Auto-generated types (git-ignored)
│   ├── ledger.ts    # Main Ledger class
│   ├── client.ts    # HTTP client
│   └── ...
├── scripts/         # Build scripts
├── specs/          # OpenAPI/AsyncAPI specifications
├── lib/            # Compiled full version (git-ignored)
├── lib-lite/       # Compiled lite version (git-ignored)
├── package.json
├── tsconfig.json
└── README.md
```

## Next Steps

1. Read the [README.md](./README.md) for API documentation
2. Check [BUILD.md](./BUILD.md) for build system details
3. See [VERSIONED_TEMPLATES.md](./VERSIONED_TEMPLATES.md) for template versioning

## Troubleshooting

### Build Fails

- Ensure you have the latest specifications in the `specs/` directory
- Check that Node.js and pnpm versions meet the requirements
- Try cleaning and rebuilding: `rm -rf lib lib-lite node_modules && pnpm install && pnpm build`

### Import Errors

- Make sure the package is built: `pnpm build`
- Check that the `lib/` directory exists and contains the compiled files
- Verify the import path matches the exports in `package.json`
