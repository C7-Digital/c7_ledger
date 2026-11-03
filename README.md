# Ledger

Type safe interactions with Canton node via [JSON API](https://docs.digitalasset.com/build/3.4/reference/json-api/json-api.html).

- [C7/Ledger](ledger/README.md)
- [C7/React](react/README.md)
- [C7/Scribe](scribe/README.md)

## Supported versions

Each `@c7-digital/ledger` release targets one Canton release line: the line that the
Canton Network (DevNet, TestNet, MainNet) runs when the release is made. We build and
test against that line only. To use a different Canton line, use the release whose row
names it.

### `@c7-digital/ledger`

| `@c7-digital/ledger` | Canton (JSON Ledger API spec) | Splice | Daml SDK: built with / apps use (`@daml/types`) | Tested against |
|---|---|---|---|---|
| 0.0.47 | 3.6.x (`3.6.5-snapshot.20261027`, Canton `release-line-3.6`) | 0.9.x | 3.5.2 / `>=3.4.0 <4.0.0` | Unit tests on the 3.6 types; a consumer app's behavior specs on a Canton 3.5.18 participant |
| 0.0.16 – 0.0.46 | 3.5.x (`3.5.1-snapshot.20260423.18760.0`) | 0.6.x – 0.8.x | 3.4.11 / `>=3.4.0 <4.0.0` | Unit tests |

"Tested against" names the participants that a release was checked on. Add a row
for each release that changes a column.

The Daml SDK column has two parts. "Built with" is the SDK of this repository's
tests, CI (`dpm install`) and generated Splice bindings: the SDK that the target
Splice line builds with. "Apps use" is the `@daml/types` peer range: an app installs
its own `@daml/types` in that range.

### `@c7-digital/scan`

Each `@c7-digital/scan` release targets the Scan API of one Splice release: the
release that the networks run. The Splice DARs give the types of the contract
payloads that Scan returns.

| `@c7-digital/scan` | Splice (Scan API spec) | Splice DARs | Tested against |
|---|---|---|---|
| 0.0.17 | 0.9.4 (`scan/specs/scan_bundled_0.9.4.yaml`) | `splice-amulet` 0.1.24, `splice-amulet-name-service` 0.1.25, `splice-dso-governance` 0.1.30 | Unit tests; a consumer app's holdings reads on a Splice 0.8.3 Scan |
| 0.0.16 and earlier | 0.6.1 | `splice-amulet` 0.1.18, `splice-amulet-name-service` 0.1.19, `splice-dso-governance` 0.1.24 | Unit tests |

A test (`scan/src/client.paths.test.ts`) checks that each path `ScanClient` calls
is in the target spec. The exceptions are `/v1/dso` and `/v0/sv-info`, which a
later Splice line adds: the client reads them first and uses its fallback on a 404.

#### Migrating to scan 0.0.17

- `@daml/types` is a peer dependency, not a dependency. An app that uses scan
  installs `@daml/types` itself (`pnpm add @daml/types@3.5.2`). Then the app and the
  packages share one copy, and their `ContractId` and `Party` types agree.
- `getAcsSnapshot` reads `/v2/state/acs` and `getHoldingsState` reads
  `/v2/holdings/state`. Splice 0.9 removes the `/v0` paths. The page token
  (`after`, `next_page_token`) is an opaque string, not a number. Each entry of
  `created_events` is an `ActiveContract`: it has no `event_type` or `event_id`,
  and it can have `created_in_update_id`.
- `getHoldingsSummary` reads `/v1/holdings/summary`. Splice deprecates the `/v0`
  path. The response has no `computed_as_of_round` and no holding-fee fields
  (`accumulated_holding_fees_*`, `total_available_coin`), and the request has no
  `as_of_round`.
- These methods are removed, because Splice 0.9 removes their endpoints:
  `getAggregatedRounds`, `getRoundOfLatestData`, `listRoundTotals`,
  `listRoundPartyTotals`, `getTopProvidersByAppRewards`,
  `getTopValidatorsByValidatorFaucets`, `getSynchronizerIdentities` and
  `getSynchronizerBootstrappingTransactions`. For round and reward data, read the
  update history (`getUpdates`) or the reward-accounting endpoints.

## Follow-ups

- **Parse missing package names from structured error fields, not prose.**
  `parseMissingPackageNames` in `ledger/src/ledger.ts` recovers the unknown
  package names from the `PACKAGE_NAMES_NOT_FOUND` error's `cause` string,
  because Canton (checked against v3.5.14) puts them only there. The stream's
  behavior is safe if the wording drifts — it degrades to fail-loud — but if a
  future Canton exposes the names in the error's structured `resources` /
  `context`, switch to those and delete the regex.
