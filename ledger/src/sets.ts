import { emptyMap, Map as DamlMap } from "@daml/types";

/**
 * Immutable Set mirroring Daml's DA.Set.Types.Set<T>.
 *
 * Structurally compatible with the codegen's `{ map: DamlMap<T, {}> }`,
 * so instances can be passed directly to template payloads and choice arguments.
 */
export interface DamlSet<T> {
  /** The underlying Map<T, Unit>. Exposed for codegen compatibility. */
  readonly map: DamlMap<T, {}>;

  /** Check if the set contains an item. */
  has(item: T): boolean;

  /** Add an item, returning a new set. */
  add(item: T): DamlSet<T>;

  /** Remove an item, returning a new set. */
  delete(item: T): DamlSet<T>;

  /** Return an iterator over the set's items. */
  values(): Iterator<T, undefined, undefined>;

  /** Return the set's items as an array. */
  toArray(): T[];

  /** Return the number of items in the set. */
  readonly size: number;

  /** Call a function for each item in the set. */
  forEach(f: (item: T) => void): void;
}

class DamlSetImpl<T> implements DamlSet<T> {
  readonly map: DamlMap<T, {}>;

  constructor(map: DamlMap<T, {}>) {
    this.map = map;
  }

  has(item: T): boolean {
    return this.map.has(item);
  }

  add(item: T): DamlSet<T> {
    return new DamlSetImpl(this.map.set(item, {}));
  }

  delete(item: T): DamlSet<T> {
    return new DamlSetImpl(this.map.delete(item));
  }

  values(): Iterator<T, undefined, undefined> {
    return this.map.keys();
  }

  toArray(): T[] {
    return this.map.entriesArray().map(([k]) => k);
  }

  get size(): number {
    return this.map.entriesArray().length;
  }

  forEach(f: (item: T) => void): void {
    this.map.forEach((_v, k) => f(k));
  }
}

/** Create a DamlSet from an array of items. */
export function create<T>(items: T[]): DamlSet<T> {
  let map = emptyMap<T, {}>();
  for (const item of items) {
    map = map.set(item, {});
  }
  return new DamlSetImpl(map);
}

/** Create an empty DamlSet. */
export function empty<T>(): DamlSet<T> {
  return new DamlSetImpl(emptyMap<T, {}>());
}
