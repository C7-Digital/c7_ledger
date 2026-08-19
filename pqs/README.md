# @c7-digital/pqs

A typed TypeScript client for the Canton **Participant Query Store (PQS)**.

PQS projects a participant's ledger into PostgreSQL and provisions a SQL read
API — the table-valued functions `active`, `creates`, `archives`, and
`exercises` over JSONB payloads. This package wraps those functions and attaches
the Daml **codegen types**, so you read typed contracts and exercise results
instead of hand-writing `payload->>'field'`.

It uses [postgres.js](https://github.com/porsager/postgres) underneath — one
small dependency, tagged-template `sql` for the escape hatch — not an ORM.

## Why typed

PQS's `payload` (and a choice's `argument` / `result`) JSONB is the same Daml-LF
JSON encoding the codegen describes. And PQS names entities as
`package:Module:Entity` — the exact identity a codegen `Template`/`Choice`
already carries (its `templateId`, minus the Daml `#` marker). So the client
attaches the existing types with no re-modelling.

```ts
import { PqsClient } from "@c7-digital/pqs";
import { Amulet, AmuletRules } from "@c7-digital/splice-codegen"; // codegen objects

const pqs = new PqsClient({
  connectionString: "postgresql://cnadmin:supersafe@localhost:5432/pqs",
});

// Active contracts — `.payload` is the codegen Amulet type:
const amulets = await pqs.active(Amulet.Amulet);

// Choice exercises — `.argument` and `.result` are typed; `.result.summary`
// is the TransferSummary where per-round Amulet accounting lives:
const transfers = await pqs.exercises(AmuletRules.AmuletRules_Transfer, {
  fromOffset,
  toOffset,
});

await pqs.close();
```

You can also pass raw `package:Module:Entity` / `:Choice` strings (via
`templateName` / `choiceName`) when you do not have the codegen object at hand.

## API

`new PqsClient(config)` — `config` is `{ connectionString }` or `{ sql }`
(inject an existing postgres.js instance; the client will not close a supplied
instance).

**Reads (table functions)**
- `active(template, { atOffset? })` → `Contract<T>[]`
- `creates(template, { fromOffset?, toOffset? })` → `CreateEvent<T>[]`
- `archives(template, { fromOffset?, toOffset? })` → `ArchiveEvent[]`
- `exercises(choice, { fromOffset?, toOffset? })` → `ExerciseEvent<Arg, Result>[]`

**Lookup by contract id**
- `lookupContract(cid)` → `Contract<unknown>[]` (the contract + its interface views)
- `lookupExercises(cid)` → `ExerciseEvent<unknown, unknown>[]`

**Summaries** (per-template counts; cheap parity check for a shadow compare)
- `summaryActive(atOffset?)`, `summaryCreates(range?)`, `summaryArchives(range?)`,
  `summaryExercises(range?)`, `summaryTransients(range?)`, `summaryUpdates(range?)`
  → `SummaryRow[]` (`{ templateFqn, counts }`)

**Offset / consistency**
- `latestOffset()` → `Offset | null`
- `validateOffset(offset)` → rejects until the datastore holds a contiguous
  history through `offset` (the read-your-writes / HA-wait primitive)
- `nearestOffset(time)` → `Offset | null` (time or interval string like `-P1D`)
- `prunedOffset()` → `Offset | null`

**Escape hatch**
- `sql` — the underlying postgres.js instance, for raw queries and joins.
- `close()`

Row types carry the enrichment PQS returns: `packageName`, `packageVersion`,
`metadata` (the disclosure blob — null unless the template is in scribe's
`--pipeline-filter-metadata`), `witnesses`, `divulgedOnly`, `payloadType`.

Offsets are passed per call, so the client is stateless — it never depends on
the `set_latest` / `set_oldest` session scope.

**Out of scope.** The destructive/ops maintenance functions
(`prune_to_offset` / `reset_to_offset` / `redact_contract` / `redact_exercise` /
`create_index_for_contract`) are deliberately NOT exposed — a read client must
not reach them. Use SQL/CLI, or a future `@c7-digital/pqs/admin` surface.

## Requirements

- A PQS instance in **TransactionTreeStream** mode, or `exercises()` returns
  nothing (the default `TransactionStream` records creates/archives only). The
  c7lock LocalNet ships one: `just local::pqs-up`.
- Peers: `@c7-digital/ledger` (branded party/contract ids) and `@daml/types`.

## Tests

- Unit tests (`identifiers.test.ts`, `rows.test.ts`) are pure and need no
  database.
- `client.integration.test.ts` runs only when `PQS_TEST_URL` is set:

  ```bash
  PQS_TEST_URL=postgresql://cnadmin:supersafe@localhost:5432/pqs \
    pnpm --filter @c7-digital/pqs test
  ```

## Not yet built

A typed JSONB predicate DSL (`where(c => eq(c.payload.provider, party))`). For
now, filter with the `sql` escape hatch or in TypeScript after the read.
