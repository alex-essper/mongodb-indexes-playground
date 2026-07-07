import type { Db, IndexSpecification, CreateIndexesOptions, Document } from "mongodb";
import type { Faker } from "@faker-js/faker";

/** Seeded generator context passed to every `doc(i, ctx, params)`. All helpers
 *  are deterministic for a given `config.seed`. */
export interface Ctx {
    /** Seeded faker instance (see https://fakerjs.dev). */
    faker: Faker;
    /** Inclusive random integer in [min, max]. */
    int(min: number, max: number): number;
    /** Random element of `arr`. */
    pick<T>(arr: readonly T[]): T;
    /** `fn()` with probability `p`, else `null`. Use for optional relationships. */
    maybe<T>(p: number, fn: () => T): T | null;
    /** `true` with probability `p`. Use to conditionally OMIT a field (vs maybe's null). */
    chance(p: number): boolean;
    /** An `_id` from an already-seeded collection: random, or at position `key`. */
    ref(name: string, key?: number): unknown;
    /** `n` distinct random `_id`s from an already-seeded collection (many-to-many). */
    refs(name: string, n: number): unknown[];
}

export interface IndexSpec {
    /** Collection the index is built on. */
    on: string;
    keys: IndexSpecification;
    options?: CreateIndexesOptions;
}

export interface Collection<S> {
    count: number;
    /** `params` is the current seed variant's value (inferred from `seedVariants`). */
    doc: (i: number, ctx: Ctx, params: S) => Document;
}

import type { FindCursor } from "mongodb";

export interface Query {
    /** The query minus pagination (filter + any sort). Return the cursor un-awaited. */
    find: (db: Db) => FindCursor;
    /** skip/limit applied to the TIMED run only; stripped for the accuracy pass. */
    page?: { skip?: number; limit?: number };
    /** Required. Run on every doc of the full result; return false to abort the run. */
    check: (doc: Document) => boolean;
}
export type QueryGroup = Query | { variants: Record<string, Query> };

export interface BenchmarkDef<S> {
    /** Optional: re-seed differently per variant; each value becomes `doc`'s 3rd arg. */
    seedVariants?: Record<string, S>;
    collections: Record<string, Collection<S>>;
    /** A `noIndexes` reference variant is added automatically. */
    indexVariants: Record<string, IndexSpec[]>;
    queries: Record<string, QueryGroup>;
}

/** Identity at runtime; provides type inference (ctx, db, and the seed-variant
 *  param `S` threaded into `doc`). */
export function defineBenchmark<S = Record<string, never>>(def: BenchmarkDef<S>): BenchmarkDef<S>;
