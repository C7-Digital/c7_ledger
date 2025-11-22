# Getting Started with @c7/react

This guide will help you set up and start using the @c7/react package.

## Prerequisites

- Node.js >= 18.0.0
- pnpm >= 8.0.0
- React >= 18.0.0

## Installation

### For Development

```bash
pnpm install
```

**Important**: This package depends on `@c7/ledger`. You have two options:

#### Option 1: Install from npm (after publishing)

```bash
pnpm install @c7/ledger
```

#### Option 2: Link locally during development

```bash
# First, in the c7_ledger directory
cd ../c7_ledger
pnpm link --global

# Then, in the c7_react directory
cd ../c7_react
pnpm link --global @c7/ledger
```

#### Option 3: Use workspace protocol (monorepo setup)

If you're managing both packages together, you can use a pnpm workspace. Create a `pnpm-workspace.yaml` in the parent directory:

```yaml
packages:
  - 'c7_ledger'
  - 'c7_react'
```

Then update the dependency in `package.json` to:
```json
{
  "dependencies": {
    "@c7/ledger": "workspace:*"
  }
}
```

### Building the Package

```bash
pnpm build
```

This will compile TypeScript to JavaScript and output to the `dist/` directory.

## Development Workflow

### Clean Build Artifacts

Remove all generated files and build outputs:

```bash
pnpm clean
```

This removes the `dist/` directory containing all compiled JavaScript and type definitions.

### Watch Mode

For continuous development with automatic recompilation:

```bash
pnpm dev
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
pnpm link --global @c7/react
```

### Option 3: Use as File Dependency

In your project's `package.json`:

```json
{
  "dependencies": {
    "@c7/react": "file:../c7_react",
    "@c7/ledger": "file:../c7_ledger"
  }
}
```

## Project Structure

```
c7_react/
├── src/                    # Source TypeScript files
│   ├── context.ts         # React context and hooks implementation
│   ├── types.ts           # TypeScript type definitions
│   ├── index.ts           # Main exports
│   └── defaultLedgerContext.ts
├── dist/                  # Compiled output (git-ignored)
├── package.json
├── tsconfig.json
└── README.md
```

## Quick Example

After installation and building, you can use it in your React app:

```tsx
import { DamlLedger, useQuery } from "@c7/react";
import { Ledger } from "@c7/ledger";

const ledger = new Ledger({
  httpBaseUrl: "http://localhost:7575",
  token: "your-jwt-token",
});

function App() {
  return (
    <DamlLedger ledger={ledger} party="Alice::1220...">
      <MyComponent />
    </DamlLedger>
  );
}

function MyComponent() {
  const { contracts, loading } = useQuery("YourTemplate");

  if (loading) return <div>Loading...</div>;
  return <div>Contracts: {contracts.length}</div>;
}
```

## Next Steps

1. Read the [README.md](./README.md) for full API documentation
2. Check the examples in the README for common patterns
3. Review the TypeScript types in `src/types.ts` for available options

## Troubleshooting

### Build Fails

- Ensure `@c7/ledger` is properly installed and built
- Check that Node.js and pnpm versions meet the requirements
- Try cleaning and rebuilding: `rm -rf dist node_modules && pnpm install && pnpm build`

### Import Errors

- Make sure the package is built: `pnpm build`
- Check that the `dist/` directory exists and contains the compiled files
- Verify that `@c7/ledger` is available

### Type Errors

- Ensure you're using React >= 18.0.0
- Make sure `@c7/ledger` types are properly exported
- Check that your TypeScript version is compatible (>= 5.0)
