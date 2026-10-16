/**
 * Row and identity types for the PQS client.
 *
 * The payload/argument/result shapes are the Daml-LF JSON encodings PQS stores
 * in its JSONB columns — the same shapes the Daml codegen describes. So a
 * `Contract<Amulet>` carries the codegen `Amulet` type in `payload` without any
 * re-modelling; the client only attaches it.
 */

import type {
  IdentifierString,
  NameString,
  PartyIdString,
} from "@c7-digital/ledger";
import type { ContractId } from "@daml/types";

declare const OFFSET: unique symbol;
/**
 * A participant ledger offset. Daml 3.x models offsets as integers, stored in
 * PQS as Postgres `bigint` (int8, signed 64-bit, max 2^63-1) — beyond JS
 * `number`'s exact range (2^53-1), so we carry it as `bigint`.
 */
export type Offset = bigint & { readonly [OFFSET]: "Offset" };

/** Wrap a raw integer as an {@link Offset}. */
export function asOffset(value: bigint): Offset {
  return value as Offset;
}

declare const TEMPLATE_PAYLOAD: unique symbol;
/**
 * A PQS entity identifier (`package:Module:Entity`), phantom-typed by the
 * template payload it returns. Build one with {@link templateName}.
 */
export type TemplateName<Payload> = string & {
  readonly [TEMPLATE_PAYLOAD]: Payload;
};

declare const CHOICE_ARG: unique symbol;
declare const CHOICE_RES: unique symbol;
/**
 * A PQS choice identifier (`package:Module:Choice`), phantom-typed by the
 * choice argument and result. Build one with {@link choiceName}.
 */
export type ChoiceName<Argument, Result> = string & {
  readonly [CHOICE_ARG]: Argument;
  readonly [CHOICE_RES]: Result;
};

/** Whether a returned row is a template payload or an interface-view projection. */
export type PayloadType = "template" | "interface";

/** An active or historical contract with its typed payload. */
export interface Contract<Payload> {
  contractId: ContractId<Payload>;
  /**
   * The template or interface this row projects. One contract has a template
   * row and one row per interface view, all with the same contract id.
   */
  templateFqn: IdentifierString;
  payload: Payload;
  payloadType: PayloadType;
  createdAtOffset: Offset;
  createdEffectiveAt: Date;
  /** Null while the contract is still active. */
  archivedAtOffset: Offset | null;
  signatories: PartyIdString[];
  observers: PartyIdString[];
  witnesses: PartyIdString[];
  divulgedOnly: boolean;
  packageName: string;
  packageVersion: string;
  /**
   * The explicit-disclosure blob (`created_event_blob`). Null unless the
   * template is included in scribe's `--pipeline-filter-metadata`.
   */
  metadata: Uint8Array | null;
}

/** A contract-create event with its typed payload. */
export interface CreateEvent<Payload> {
  contractId: ContractId<Payload>;
  /** The template or interface this row projects (see {@link Contract.templateFqn}). */
  templateFqn: IdentifierString;
  payload: Payload;
  payloadType: PayloadType;
  createdAtOffset: Offset;
  createdEffectiveAt: Date;
  signatories: PartyIdString[];
  observers: PartyIdString[];
  witnesses: PartyIdString[];
  divulgedOnly: boolean;
  packageName: string;
  packageVersion: string;
  metadata: Uint8Array | null;
}

/** A contract-archive event. */
export interface ArchiveEvent {
  contractId: ContractId<unknown>;
  templateFqn: IdentifierString;
  archivedAtOffset: Offset;
  archivedEffectiveAt: Date;
}

/** A choice-exercise event with its typed argument and result. */
export interface ExerciseEvent<Argument, Result> {
  contractId: ContractId<unknown>;
  templateFqn: IdentifierString;
  choice: NameString;
  choiceFqn: string;
  consuming: boolean;
  argument: Argument;
  result: Result;
  exercisedAtOffset: Offset;
  exercisedEffectiveAt: Date;
  /** The parties that collectively exercised the choice (acting parties). */
  actingParties: PartyIdString[];
  witnesses: PartyIdString[];
  packageName: string;
  packageVersion: string;
}

/** An offset window for the historical `creates`/`archives`/`exercises` reads. */
export interface OffsetRange {
  fromOffset?: Offset;
  toOffset?: Offset;
}

/**
 * One row of `summary_active`, `summary_creates`, `summary_archives` or
 * `summary_transients`: the count for one template or one interface view.
 */
export interface ContractCountRow {
  templateFqn: IdentifierString;
  payloadType: PayloadType;
  count: number;
}

/** One row of `summary_updates`: the create and archive counts for one template or interface view. */
export interface UpdateCountRow {
  templateFqn: IdentifierString;
  payloadType: PayloadType;
  creates: number;
  archives: number;
}

/** One row of `summary_exercises`: the exercise count of one choice. */
export interface ChoiceCountRow {
  /** The template or interface that declares the choice. */
  templateFqn: IdentifierString;
  choice: NameString;
  choiceFqn: string;
  consuming: boolean;
  count: number;
}
