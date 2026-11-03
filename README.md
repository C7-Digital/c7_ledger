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

| `@c7-digital/ledger` | Canton (JSON Ledger API spec) | Splice | Daml SDK (`@daml/types`) | Tested against |
|---|---|---|---|---|
| 0.0.47 | 3.6.x (`3.6.5-snapshot.20261027`, Canton `release-line-3.6`) | 0.9.x | 3.4.11 | Unit tests on the 3.6 types; `getPreferredPackages` by hand on a Canton 3.5.18 participant |
| 0.0.16 – 0.0.46 | 3.5.x (`3.5.1-snapshot.20260423.18760.0`) | 0.6.x – 0.8.x | 3.4.11 | Unit tests |

"Tested against" names the participants that a release was checked on. Add a row
for each release that changes a column.

## Follow-ups

- **Parse missing package names from structured error fields, not prose.**
  `parseMissingPackageNames` in `ledger/src/ledger.ts` recovers the unknown
  package names from the `PACKAGE_NAMES_NOT_FOUND` error's `cause` string,
  because Canton (checked against v3.5.14) puts them only there. The stream's
  behavior is safe if the wording drifts — it degrades to fail-loud — but if a
  future Canton exposes the names in the error's structured `resources` /
  `context`, switch to those and delete the regex.
