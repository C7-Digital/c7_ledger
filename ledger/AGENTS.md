# ledger/ — agent notes

`@c7-digital/ledger`: type-safe Canton JSON Ledger API v2 client.

## Layout

```
src/
  ledger.ts          # Ledger class — submit, query, ACS streams, missing-package recovery
  client.ts          # TypedHttpClient
  websocket.ts       # ACS / updates / completions streams
  error.ts           # LedgerApiError, readErrorBody, tagged LedgerErrorBody
  cantonError.ts     # Canton payload vocabulary (categoryOf, isRetryable, …)
  submitError.ts     # Submit failure classification (retry + command dedup)
  types.ts           # JsCantonError, wire types, isCantonError guard
  generated/         # OpenAPI + AsyncAPI codegen (gitignored — produced by build)
  api-surface.test.ts  # Public export contract — update when adding exports
specs/               # Checked-in OpenAPI/AsyncAPI YAML per Canton version
scripts/build.ts     # Codegen + branding + lib / lib-lite dual build
lib/                 # Full build with runtime validation (published)
lib-lite/            # Lite build without embedded schemas (@c7-digital/ledger/lite)
```

## Build / specs

Default build targets Canton **3.5.x** (splice 0.6.x participants). Local `dpm sandbox` uses **3.4.11**:

```bash
pnpm build                                              # default spec
pnpm build -- --sdk-version=3.4.11                      # sandbox line
```

Details: [BUILD.md](BUILD.md), [README.md](README.md#versioning).

**Do not hand-edit** `src/generated/`, `lib/`, or `lib-lite/`. Change specs or build scripts, then rebuild.

## Errors module map

| Module | Responsibility |
|--------|----------------|
| `error.ts` | HTTP non-OK → `LedgerApiError` with tagged body (`canton` / `json` / `text` / `empty`) |
| `cantonError.ts` | Interpret structured Canton rejections (`errorCategory`, retryable, resources) |
| `submitError.ts` | Submit retry/dedup helpers (consumer-app parity + `isIndeterminateSubmitError`) |

`ScanApiError` in `@c7-digital/scan` mirrors `LedgerApiError` field shapes for shared `catch` blocks.

## Tests

```bash
pnpm test                                    # all ledger tests
pnpm test -- --testPathPattern=cantonError  # error vocabulary
pnpm test -- --testPathPattern=submitError  # submit classification
pnpm test -- --testPathPattern=api-surface  # export contract
```

When adding a public export, update **both** `src/index.ts` and the `it.each([...])` list in `api-surface.test.ts`.

## Release

1. Bump `version` in `ledger/package.json`.
2. If react peer range no longer admits the version, widen `react/package.json` `peerDependencies["@c7-digital/ledger"]`.
3. From repo root: `pnpm release -- --package ledger`.
4. In each consumer app: bump `"@c7-digital/ledger"` in every `package.json` that lists it, `pnpm install`, rebuild.

Skill: [../.claude/skills/ledger-release/SKILL.md](../.claude/skills/ledger-release/SKILL.md).
