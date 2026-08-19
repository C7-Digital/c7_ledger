/**
 * A typed client over the PQS SQL API.
 *
 * PQS provisions its read API as PostgreSQL table-valued functions
 * (`active`/`creates`/`archives`/`exercises`) over JSONB payloads. This client
 * wraps those functions and attaches the Daml codegen types, so callers read
 * typed contracts and exercise results instead of hand-writing `payload->>'…'`.
 *
 * The offset arguments the functions accept are passed per call, so the client
 * is stateless — it never relies on the `set_latest`/`set_oldest` session scope.
 */

import type { Choice, Template } from "@daml/types";
import postgres, { type Sql } from "postgres";

import { choiceName, templateName } from "./identifiers.js";
import {
  toArchive,
  toContract,
  toCreate,
  toExercise,
  toSummaryRow,
  type PqsRow,
} from "./rows.js";
import {
  asOffset,
  type ArchiveEvent,
  type ChoiceName,
  type Contract,
  type CreateEvent,
  type ExerciseEvent,
  type Offset,
  type OffsetRange,
  type SummaryRow,
  type TemplateName,
} from "./types.js";

/**
 * A postgres.js instance configured to carry Postgres `bigint` (int8) as a JS
 * `bigint`. Required so ledger offsets keep full precision on read AND can be
 * passed back as query parameters — postgres.js's default parameter type omits
 * `bigint`, and its default reader returns int8 as a string.
 */
export type PqsSql = Sql<{ bigint: bigint }>;

const PQS_SQL_OPTIONS = { types: { bigint: postgres.BigInt } } as const;

export interface PqsClientConfig {
  /** A PostgreSQL connection string, e.g. `postgresql://user:pass@host:5432/pqs`. */
  connectionString?: string;
  /**
   * An existing postgres.js instance to use instead of opening one. Takes
   * precedence over `connectionString`. Useful for pooling and for tests. Must
   * be configured with `{ types: { bigint: postgres.BigInt } }`. The client will
   * not close an instance it did not open (see {@link PqsClient.close}).
   */
  sql?: PqsSql;
}

export class PqsClient {
  /** The underlying postgres.js instance, for raw queries and joins. */
  readonly sql: PqsSql;
  private readonly ownsSql: boolean;

  constructor(config: PqsClientConfig) {
    this.ownsSql = config.sql === undefined;
    this.sql =
      config.sql ?? postgres(config.connectionString ?? "", PQS_SQL_OPTIONS);
  }

  /** Active contracts of a template (optionally as of a past offset). */
  async active<T extends object>(
    template: Template<T, any, string> | TemplateName<T>,
    opts?: { atOffset?: Offset },
  ): Promise<Contract<T>[]> {
    const name = resolveTemplate(template);
    const rows = await this.rows(
      this.sql`SELECT * FROM active(${name}, ${opts?.atOffset ?? null})`,
    );
    return rows.map((r) => toContract<T>(r));
  }

  /** Create events of a template within an offset range. */
  async creates<T extends object>(
    template: Template<T, any, string> | TemplateName<T>,
    opts?: OffsetRange,
  ): Promise<CreateEvent<T>[]> {
    const name = resolveTemplate(template);
    const rows = await this.rows(
      this.sql`SELECT * FROM creates(${name}, ${opts?.fromOffset ?? null}, ${opts?.toOffset ?? null})`,
    );
    return rows.map((r) => toCreate<T>(r));
  }

  /** Archive events of a template within an offset range. */
  async archives<T extends object>(
    template: Template<T, any, string> | TemplateName<T>,
    opts?: OffsetRange,
  ): Promise<ArchiveEvent[]> {
    const name = resolveTemplate(template);
    const rows = await this.rows(
      this.sql`SELECT * FROM archives(${name}, ${opts?.fromOffset ?? null}, ${opts?.toOffset ?? null})`,
    );
    return rows.map((r) => toArchive(r));
  }

  /** Exercise events of a choice within an offset range, with typed arg/result. */
  async exercises<T extends object, C, R>(
    choice: Choice<T, C, R, any> | ChoiceName<C, R>,
    opts?: OffsetRange,
  ): Promise<ExerciseEvent<C, R>[]> {
    const name = resolveChoice(choice);
    const rows = await this.rows(
      this.sql`SELECT * FROM exercises(${name}, ${opts?.fromOffset ?? null}, ${opts?.toOffset ?? null})`,
    );
    return rows.map((r) => toExercise<C, R>(r));
  }

  /** A contract and all its interface-view projections, by contract id. */
  async lookupContract(contractId: string): Promise<Contract<unknown>[]> {
    const rows = await this.rows(this.sql`SELECT * FROM lookup_contract(${contractId})`);
    return rows.map((r) => toContract<unknown>(r));
  }

  /** All exercise events on a contract, by contract id. */
  async lookupExercises(contractId: string): Promise<ExerciseEvent<unknown, unknown>[]> {
    const rows = await this.rows(this.sql`SELECT * FROM lookup_exercises(${contractId})`);
    return rows.map((r) => toExercise<unknown, unknown>(r));
  }

  /** Active-contract count per template as of an offset. */
  async summaryActive(atOffset?: Offset): Promise<SummaryRow[]> {
    const rows = await this.rows(this.sql`SELECT * FROM summary_active(${atOffset ?? null})`);
    return rows.map(toSummaryRow);
  }

  /** Create count per template in an offset range. */
  async summaryCreates(opts?: OffsetRange): Promise<SummaryRow[]> {
    const rows = await this.rows(
      this.sql`SELECT * FROM summary_creates(${opts?.fromOffset ?? null}, ${opts?.toOffset ?? null})`,
    );
    return rows.map(toSummaryRow);
  }

  /** Archive count per template in an offset range. */
  async summaryArchives(opts?: OffsetRange): Promise<SummaryRow[]> {
    const rows = await this.rows(
      this.sql`SELECT * FROM summary_archives(${opts?.fromOffset ?? null}, ${opts?.toOffset ?? null})`,
    );
    return rows.map(toSummaryRow);
  }

  /** Exercise count per template in an offset range. */
  async summaryExercises(opts?: OffsetRange): Promise<SummaryRow[]> {
    const rows = await this.rows(
      this.sql`SELECT * FROM summary_exercises(${opts?.fromOffset ?? null}, ${opts?.toOffset ?? null})`,
    );
    return rows.map(toSummaryRow);
  }

  /** Transient (create+archive in one tx) count per template in an offset range. */
  async summaryTransients(opts?: OffsetRange): Promise<SummaryRow[]> {
    const rows = await this.rows(
      this.sql`SELECT * FROM summary_transients(${opts?.fromOffset ?? null}, ${opts?.toOffset ?? null})`,
    );
    return rows.map(toSummaryRow);
  }

  /** Create + archive counts per template in an offset range. */
  async summaryUpdates(opts?: OffsetRange): Promise<SummaryRow[]> {
    const rows = await this.rows(
      this.sql`SELECT * FROM summary_updates(${opts?.fromOffset ?? null}, ${opts?.toOffset ?? null})`,
    );
    return rows.map(toSummaryRow);
  }

  /**
   * Assert the datastore holds a contiguous history through `offset`; rejects
   * otherwise. The read-your-writes primitive — retry until it resolves to wait
   * for PQS to catch up to an offset a write returned.
   */
  async validateOffset(offset: Offset): Promise<void> {
    await this.sql`SELECT validate_offset_exists(${offset})`;
  }

  /** The offset nearest a wall-clock time (or interval string like `-P1D`). */
  async nearestOffset(time: Date | string): Promise<Offset | null> {
    return this.offsetScalar(this.sql`SELECT nearest_offset(${time}) AS offset`);
  }

  /** The offset up to which the datastore has been pruned, or null. */
  async prunedOffset(): Promise<Offset | null> {
    return this.offsetScalar(this.sql`SELECT pruned_offset() AS offset`);
  }

  /**
   * The latest offset PQS has ingested, or null on an empty datastore.
   *
   * Uses `latest_offset()`, which returns the ingestion head. (`set_latest(NULL)`
   * only sets the session's upper scope and returns NULL — it is NOT a reader.)
   */
  async latestOffset(): Promise<Offset | null> {
    return this.offsetScalar(this.sql`SELECT latest_offset() AS offset`);
  }

  /** Close the connection — only if this client opened it. */
  async close(): Promise<void> {
    if (this.ownsSql) await this.sql.end();
  }

  private async rows(query: Promise<readonly unknown[]>): Promise<PqsRow[]> {
    return (await query) as PqsRow[];
  }

  private async offsetScalar(query: Promise<readonly unknown[]>): Promise<Offset | null> {
    const rows = (await query) as PqsRow[];
    const value = rows[0]?.offset;
    return value === null || value === undefined
      ? null
      : asOffset(typeof value === "bigint" ? value : BigInt(String(value)));
  }
}

function resolveTemplate<T extends object>(
  template: Template<T, any, string> | TemplateName<T>,
): TemplateName<T> {
  return typeof template === "string" ? template : templateName(template);
}

function resolveChoice<T extends object, C, R>(
  choice: Choice<T, C, R, any> | ChoiceName<C, R>,
): ChoiceName<C, R> {
  return typeof choice === "string" ? choice : choiceName(choice);
}
