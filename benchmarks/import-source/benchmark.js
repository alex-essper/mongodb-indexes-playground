export const description =
    "source presence queries vs plain/partial indexes across 0% / 50% / 90% populated seed variants.";

import { defineBenchmark } from "../../lib/define.js";

export const config = { warmup: 5, iterations: 50, seed: 1 };

export default defineBenchmark({
    // Same records, only the fraction with a `source` field changes per seed variant.
    // `ctx.chance` (not `maybe`) so absent means the key is OMITTED, not set to null —
    // otherwise `{ source: { $exists: false } }` would not match.
    seedVariants: {
        none: { sourceRatio: 0 },
        half: { sourceRatio: 0.5 },
        most: { sourceRatio: 0.9 },
    },

    collections: {
        records: {
            count: 100_000,
            doc: (i, ctx, v) => ({
                _id: i,
                ...(ctx.chance(v.sourceRatio) ? { source: { importSource: "vendor" } } : {}),
            }),
        },
    },

    indexVariants: {
        plain: [{ on: "records", keys: { "source.importSource": 1 } }],
        partial: [
            {
                on: "records",
                keys: { "source.importSource": 1 },
                options: { partialFilterExpression: { source: { $exists: true } } },
            },
        ],
        nullPartial: [
            {
                on: "records",
                keys: { source: 1 },
                options: { partialFilterExpression: { source: { $eq: null } } },
            },
        ],
    },

    // Paginated: non-zero skip, limit ~500 (middle-of-the-road page over 100k docs).
    queries: {
        hasSource: {
            find: (db) => db.collection("records").find({ source: { $exists: true } }),
            page: { skip: 2000, limit: 500 },
            check: (doc) => doc.source != null,
        },
        sourceNoExists: {
            find: (db) => db.collection("records").find({ source: { $exists: false } }),
            page: { skip: 2000, limit: 500 },
            check: (doc) => doc.source === undefined,
        },
        // Same result set as noSource here (no explicit nulls), but `{ source: null }`
        // IS planner-indexable — this is the shape the nullPartial index can serve.
        sourceNull: {
            find: (db) => db.collection("records").find({ source: null }),
            page: { skip: 2000, limit: 500 },
            check: (doc) => doc.source == null,
        },
        byValue: {
            find: (db) => db.collection("records").find({ "source.importSource": "vendor" }),
            page: { skip: 2000, limit: 500 },
            check: (doc) => doc.source?.importSource === "vendor",
        },
    },
});
