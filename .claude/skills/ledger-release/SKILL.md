---
name: ledger-release
description: >-
  Bump, build, test, and publish @c7-digital/ledger (and sibling packages) from
  c7_ledger to npm, then update the consumer apps that pin it. Use
  when releasing a ledger patch, after merging API changes, or when the user
  asks how to version bump and install c7_ledger.
---

# Ledger release

Goal: publish `@c7-digital/ledger@X.Y.Z` to npm and update downstream pins safely.

## When this applies

- Merged c7_ledger PR changes public API or bug fixes consumers need
- User asks "do I version bump and install?" for a consumer app
- React peer dependency validation fails during release

## Monorepo packages

| npm name | Path | Current coupling |
|----------|------|------------------|
| `@c7-digital/ledger` | `ledger/` | Primary — most consumer deps |
| `@c7-digital/react` | `react/` | Peers on ledger version range |
| `@c7-digital/scan` | `scan/` | Peers on ledger |
| `@c7-digital/scribe` | `scribe/` | Independent |

Consumer apps pin exact versions, e.g. `"@c7-digital/ledger": "0.0.35"`, resolved from **registry.npmjs.org** via the app's lockfile — not a git dependency.

## Release checklist (maintainer)

```
- [ ] Changes merged to main (or release branch)
- [ ] Bump version in ledger/package.json (patch for fixes, minor for additive API)
- [ ] If releasing ledger: react/package.json peer range still admits new version
      (release script checks — widen to ">=0.0.N <0.1.0" or "^X.Y.Z" if needed)
- [ ] pnpm clean && pnpm build && pnpm test  (or pnpm release does this)
- [ ] pnpm release -- --package ledger   (interactive confirm + npm publish)
- [ ] Note published version for consumer bumps
```

## Release script behavior

`scripts/release.ts` (invoked as `pnpm release`):

1. Prompts that version was bumped in `package.json`
2. Validates react peer range when releasing ledger
3. `pnpm clean`, `pnpm build`, `pnpm test`
4. `npm publish --access public` from package directory

Ledger package publishes **`lib/`** and **`lib-lite/`** — consumers must not depend on git source paths.

## Consumer update

After `@c7-digital/ledger@0.0.36` is on npm:

1. Edit **each** `package.json` in the consumer app that lists the dep (a
   multi-package app usually pins it in several workspace packages).
2. From the consumer's workspace root:
   ```bash
   pnpm install
   pnpm test   # or the app's own test recipe
   ```
3. Commit lockfile + version pins together.

**Optional local dev** before publish:

```bash
# In c7_ledger/ledger after pnpm build
pnpm link --global
# In consumer apps/
pnpm link --global @c7-digital/ledger
```

Prefer npm publish + pin for CI and teammates.

## What to bump when

| Change | Ledger bump | Consumer action |
|--------|-------------|-----------------|
| New export (`classifySubmitError`) | patch (0.0.36) | Bump pin, thin local duplicates |
| `LedgerApiError` constructor break | minor + migration note | Coordinated bump, fix mocks |
| OpenAPI spec / `--sdk-version` default | minor/major | Full consumer typecheck |
| React-only hooks | `@c7-digital/react` only | Apps using react bump react pin |

## Verification after consumer bump

- Typecheck the consumer app's workspace
- Unit tests touching ledger error paths
- No remaining duplicate regex classifiers that ledger now owns (see `submit-error-classification` skill)

## Anti-patterns

- Pointing consumer `package.json` at `file:../c7_ledger` in committed code (local only).
- Publishing without running `api-surface.test.ts`.
- Bumping consumer pin before npm publish completes (install gets old tarball).
- Forgetting `@c7-digital/scan` / `@c7-digital/react` when their APIs changed too.

## References

- [ledger/AGENTS.md](../../../ledger/AGENTS.md)
- [scripts/release.ts](../../../scripts/release.ts)
