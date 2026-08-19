/**
 * Map raw PQS result rows (snake-cased columns, JSONB payloads) into the typed
 * row shapes. Kept pure and driver-agnostic so it is unit-testable without a
 * database: the client passes plain row objects in.
 */

import { createPartyIdString, type PartyIdString } from "@c7-digital/ledger";
import type { ContractId } from "@daml/types";

import {
  asOffset,
  type ArchiveEvent,
  type Contract,
  type CreateEvent,
  type ExerciseEvent,
  type Offset,
  type PayloadType,
  type SummaryRow,
} from "./types.js";

/** One PQS result row before typing. */
export type PqsRow = Record<string, unknown>;

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value);
}

function offset(value: unknown): Offset {
  // PQS offset columns are Postgres `bigint` (int8, signed 64-bit); postgres.js
  // returns them as a string to avoid the precision loss of JS `number` (exact
  // only to 2^53-1). Parse to `bigint` so ordering and the poll's cursor+1 stay
  // exact at any magnitude.
  return asOffset(typeof value === "bigint" ? value : BigInt(text(value)));
}

function offsetOrNull(value: unknown): Offset | null {
  return value === null || value === undefined ? null : offset(value);
}

function effectiveAt(value: unknown): Date {
  return value instanceof Date ? value : new Date(text(value));
}

function partyList(value: unknown): PartyIdString[] {
  return Array.isArray(value) ? value.map((p) => createPartyIdString(text(p))) : [];
}

function bool(value: unknown): boolean {
  return value === true || value === "t" || value === "true";
}

function bytesOrNull(value: unknown): Uint8Array | null {
  return value instanceof Uint8Array ? value : null;
}

function payloadType(value: unknown): PayloadType {
  return text(value) === "interface" ? "interface" : "template";
}

export function toContract<T>(row: PqsRow): Contract<T> {
  return {
    contractId: text(row.contract_id) as ContractId<T>,
    payload: row.payload as T,
    payloadType: payloadType(row.payload_type),
    createdAtOffset: offset(row.created_at_offset),
    createdEffectiveAt: effectiveAt(row.created_effective_at),
    archivedAtOffset: offsetOrNull(row.archived_at_offset),
    signatories: partyList(row.signatories),
    observers: partyList(row.observers),
    witnesses: partyList(row.witnesses),
    divulgedOnly: bool(row.divulged_only),
    packageName: text(row.package_name),
    packageVersion: text(row.package_version),
    metadata: bytesOrNull(row.metadata),
  };
}

export function toCreate<T>(row: PqsRow): CreateEvent<T> {
  return {
    contractId: text(row.contract_id) as ContractId<T>,
    payload: row.payload as T,
    payloadType: payloadType(row.payload_type),
    createdAtOffset: offset(row.created_at_offset),
    createdEffectiveAt: effectiveAt(row.created_effective_at),
    signatories: partyList(row.signatories),
    observers: partyList(row.observers),
    witnesses: partyList(row.witnesses),
    divulgedOnly: bool(row.divulged_only),
    packageName: text(row.package_name),
    packageVersion: text(row.package_version),
    metadata: bytesOrNull(row.metadata),
  };
}

export function toArchive(row: PqsRow): ArchiveEvent {
  return {
    contractId: text(row.contract_id) as ContractId<unknown>,
    templateFqn: text(row.template_fqn),
    archivedAtOffset: offset(row.archived_at_offset),
    archivedEffectiveAt: effectiveAt(row.archived_effective_at),
  };
}

export function toExercise<C, R>(row: PqsRow): ExerciseEvent<C, R> {
  return {
    contractId: text(row.contract_id) as ContractId<unknown>,
    templateFqn: text(row.template_fqn),
    choice: text(row.choice),
    choiceFqn: text(row.choice_fqn),
    consuming: bool(row.consuming),
    argument: row.argument as C,
    result: row.result as R,
    exercisedAtOffset: offset(row.exercised_at_offset),
    exercisedEffectiveAt: effectiveAt(row.exercised_effective_at),
    actingParties: partyList(row.controllers),
    witnesses: partyList(row.witnesses),
    packageName: text(row.package_name),
    packageVersion: text(row.package_version),
  };
}

// Map a `summary_*` row. `template_fqn` is fixed; every other numeric column is
// a count (name varies per summary function), so they are collected generically.
export function toSummaryRow(row: PqsRow): SummaryRow {
  const counts: Record<string, number> = {};
  for (const [key, value] of Object.entries(row)) {
    if (key === "template_fqn") continue;
    if (typeof value === "number") counts[key] = value;
    else if (typeof value === "bigint") counts[key] = Number(value);
    else if (
      typeof value === "string" &&
      value.trim() !== "" &&
      !Number.isNaN(Number(value))
    ) {
      counts[key] = Number(value);
    }
  }
  return { templateFqn: text(row.template_fqn), counts };
}
