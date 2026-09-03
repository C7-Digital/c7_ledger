# Ledger

Type safe interactions with Canton node via [JSON API](https://docs.digitalasset.com/build/3.4/reference/json-api/json-api.html).

- [C7/Ledger](ledger/README.md)
- [C7/React](react/README.md)
- [C7/Scribe](scribe/README.md)

- Current version: 0.0.1, Daml/Canton Target: 3.4.11

## Follow-ups

- **Parse missing package names from structured error fields, not prose.**
  `parseMissingPackageNames` in `ledger/src/ledger.ts` recovers the unknown
  package names from the `PACKAGE_NAMES_NOT_FOUND` error's `cause` string,
  because Canton (checked against v3.5.14) puts them only there. The stream's
  behavior is safe if the wording drifts — it degrades to fail-loud — but if a
  future Canton exposes the names in the error's structured `resources` /
  `context`, switch to those and delete the regex.
