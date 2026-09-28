# AGENTS.md

Guidance for AI coding agents (Cursor, Claude Code, Codex, etc.) in the **c7_ledger** monorepo.

## Project overview

TypeScript clients for Canton Network services, published to npm under `@c7-digital/*`:

| Package | Path | Role |
|---------|------|------|
| `@c7-digital/ledger` | `ledger/` | JSON Ledger API v2 client (OpenAPI + AsyncAPI codegen, ACS streams, submit) |
| `@c7-digital/react` | `react/` | React hooks over ledger |
| `@c7-digital/scan` | `scan/` | Scan API client (mining rounds, etc.) |
| `@c7-digital/scribe` | `scribe/` | Scribe integration |
| `@c7-digital/admin` | `admin/` | Admin API helpers |

**Consumers** (e.g. [domain-verification](https://github.com/C7-Digital/domain-verification)) depend on published npm versions — not git submodules. After a ledger release, bump `"@c7-digital/ledger"` in the consumer's `package.json` files and run `pnpm install`.

Package-specific notes: [ledger/AGENTS.md](ledger/AGENTS.md).

## Development commands

```bash
pnpm install              # workspace root — installs all packages

# Build / test (all packages)
pnpm build
pnpm test
pnpm clean

# Single package (from repo root)
pnpm --filter @c7-digital/ledger build
pnpm --filter @c7-digital/ledger test
pnpm --filter @c7-digital/ledger lint

# Release (interactive — bump version in package.json first)
pnpm release                          # all packages
pnpm release -- --package ledger      # ledger only
```

## Workflow dependencies

1. **ledger** build generates `ledger/src/generated/*` from `ledger/specs/` then compiles to `lib/` and `lib-lite/`.
2. **react** peers on `@c7-digital/ledger` — release script validates the peer range admits the new ledger version.
3. **scan** peers on `@c7-digital/ledger` for shared error shapes.

Always run `pnpm build && pnpm test` at repo root before opening a PR.

## Error handling boundary

Generic JSON Ledger API submit-result classification belongs **here**, not in consumer apps:

- Canton payload vocabulary: `cantonErrorOf`, `categoryOf`, `isRetryable`, `resourcesOf` (`ledger/src/cantonError.ts`)
- Submit failure helpers in `ledger/src/submitError.ts` — additive on `cantonError.ts`; lift from domain-verification plus `isIndeterminateSubmitError` for command dedup (503 + Canton deadline)

Consumers should import these helpers and keep only domain-specific retry policy (budgets, stable command ids, ACS checks, `withArchiveRetry`). Do not duplicate the classification logic in apps.

See skill: `.claude/skills/submit-error-classification/SKILL.md`.

## Development mode

- **Type-driven** — Prefer tagged sums (`LedgerErrorBody`) over optional flags. Export new public API from `ledger/src/index.ts` and add names to `api-surface.test.ts`.
- **Behavior-driven** — Green `tsc` is not done. Add unit tests beside the module (`*.test.ts`); for ledger, extend `api-surface.test.ts` when adding exports.
- **Structural over instanceof** — Error helpers use shape probes so duplicated package copies in pnpm trees still work.

## Boundaries

**Always**

- Use **pnpm** only (workspace-aware).
- Hand-edit **source** under `ledger/src/`, never committed `lib/`, `lib-lite/`, or `src/generated/`.
- Extend `api-surface.test.ts` when adding public exports from `@c7-digital/ledger`.
- Put transport-agnostic Canton interpretation in `cantonError.ts` / `submitError.ts`; envelope unwrapping stays in the transport owner.

**Ask first**

- Bumping default OpenAPI/AsyncAPI spec (`ledger/specs/`, `--sdk-version`) — affects all generated types and consumers.
- Breaking public API or `LedgerApiError` constructor shape.
- Publishing to npm (`pnpm release`).

**Never**

- Commit secrets, JWTs, or participant URLs into tests/docs.
- Re-derive Canton `errorCategory` from `code` string allow-lists when the payload already carries the integer.
- Add app-specific retry budgets or domain command-id schemes to this repo — those stay in consumers.

## Agent skills

Canonical skills: **`.claude/skills/`**. Cursor: `.cursor/skills/` (symlink). See [.claude/skills/README.md](.claude/skills/README.md).

| Skill | Use when |
|-------|----------|
| `submit-error-classification` | Adding or moving JSON API submit failure handling between ledger and apps |
| `ledger-release` | Version bump, publish to npm, consumer pin update |

## Copilot / review hygiene

Review the **error/transport slice** holistically — not just the diff hunk. If a consumer PR duplicates ledger error regexes, the fix belongs in c7_ledger first, then a version bump in the consumer.
