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
| 0.0.18 | 0.9.4 (`scan/specs/scan_bundled_0.9.4.yaml`) | `splice-amulet` 0.1.24, `splice-amulet-name-service` 0.1.25, `splice-dso-governance` 0.1.30 | Unit tests (with the list of Scans) |
| 0.0.17 | 0.9.4 (`scan/specs/scan_bundled_0.9.4.yaml`) | `splice-amulet` 0.1.24, `splice-amulet-name-service` 0.1.25, `splice-dso-governance` 0.1.30 | Unit tests; a consumer app's holdings reads on a Splice 0.8.3 Scan |
| 0.0.16 and earlier | 0.6.1 | `splice-amulet` 0.1.18, `splice-amulet-name-service` 0.1.19, `splice-dso-governance` 0.1.24 | Unit tests |

A test (`scan/src/client.paths.test.ts`) checks that each path `ScanClient` calls
is in the target spec. The exceptions are `/v1/dso` and `/v0/sv-info`, which a
later Splice line adds: the client reads them first and uses its fallback on a 404.

#### A list of Scans (0.0.18)

Each Super Validator runs a Scan, and each Scan serves the same network state.
Many SV Scans allow only the IP addresses of known validators, and refuse other
callers with 403. Give the client a list of Scans, so that it continues to work
when one Scan refuses or fails:

```ts
const scan = new ScanClient({
  baseUrls: [preferredScanUrl, ...fallbackScanUrls], // the preferred Scan first
  timeoutMs: 15_000, // for each Scan; the default for a list
  cooldownMs: 30_000, // the default
});
```

- The client sends each request to the first Scan that is not cooling down.
- These results make a Scan unavailable: a failed `fetch` (network, CORS,
  timeout), 401, 403, 408, 429 and 5xx. The client then tries the next Scan with
  the same request, and the unavailable Scan cools down. During the cooldown, all
  clients in the process try the other Scans first.
- Every other status is the network's answer, for example 400 or 404. The client
  throws its `ScanApiError` and does not ask another Scan.
- When no Scan answers, the client throws `ScanUnavailableError`. Its `attempts`
  give each Scan that the client tried, and its error.
- `isScanUnavailable(error)` tells which errors make a Scan unavailable.
- With `baseUrl` (one Scan), the client works as before: it throws the Scan's
  error, or the error of `fetch`, and it has no timeout unless you set `timeoutMs`.

The list gives availability, not trust: the client uses the first answer, and
does not compare the answers of several Scans. Use only Scans that accept
requests from your IP addresses. A browser app can also use a list: give it the
paths of same-origin proxies, one for each Scan.

#### The validator's scan proxy (0.0.18)

A validator reads Scan with Splice's BFT Scan connection: it asks several Scans
and needs f+1 equal answers. Its scan proxy (`/v0/scan-proxy/*` of the
validator API) gives these reads to apps. Add it to the config, and the reads
that the proxy serves go to it first:

```ts
const scan = new ScanClient({
  baseUrls: [preferredScanUrl, ...fallbackScanUrls],
  validator: {
    baseUrl: "https://validator.example.com/api/validator", // or a same-origin proxy path
    token: () => auth.accessToken(), // called for each request; undefined reads the Scans
  },
  onRead: ({ path, source, baseUrl }) => metrics.count(source), // optional
});
```

- The proxy needs a JWT that the validator accepts (its issuer and audience).
  It needs no user rights.
- `PROXY_PATHS` lists the reads that the proxy serves: the DSO party and DSO
  info (`/v1/scan-proxy/dso` from Splice 0.10), featured-app rights, rounds,
  AmuletRules, ANS, transfer preapprovals and commands, holdings summaries, and
  unclaimed development-fund coupons. Every other read goes to the Scans.
- When the proxy is unavailable (the same statuses as a Scan), the client logs
  a warning, reads the Scans, and tries the Scans first for `cooldownMs`. A 404
  is the network's answer, except for a path that the validator does not serve
  (an older Splice line): then the client reads the Scans for that path.
- A 401 from the proxy is a configuration error: the client throws
  `ScanProxyAuthError` and does not read the Scans.
- The proxy answers two reads in a different shape from Scan.
  `getCurrentMiningRounds()` and `getCurrentAmuletRules()` give the proxy's
  shape (full contracts). Without a proxy they read Scan with an empty cache.
  `getOpenAndIssuingMiningRounds()` and `getAmuletRules()` keep Scan's cache
  protocol, and always read the Scans.
- `scan/specs/scan_proxy_0.9.4.yaml` is the validator's proxy spec, and
  `client.paths.test.ts` checks `PROXY_PATHS` against it.

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
