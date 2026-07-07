import { makeCtx } from "./ctx.js";

const BATCH = 5000;
const DEFAULTS = { warmup: 5, iterations: 50, seed: 1 };

// Seed every collection once, in declaration order. Later collections can ref
// earlier ones through ctx.
async function seed(db, collections, seed, params) {
    const { ctx, idsByCollection } = makeCtx(seed);
    for (const [name, spec] of Object.entries(collections)) {
        const coll = db.collection(name);
        const ids = [];
        let batch = [];
        const flush = async () => {
            if (!batch.length) return;
            await coll.insertMany(batch, { ordered: false });
            for (const d of batch) ids.push(d._id);
            batch = [];
        };
        for (let i = 0; i < spec.count; i++) {
            batch.push(spec.doc(i, ctx, params));
            if (batch.length >= BATCH) await flush();
        }
        await flush();
        idsByCollection[name] = ids; // available to collections seeded after this one
        console.log(`  seeded ${name}: ${ids.length} docs`);
    }
}

// Drop every non-_id index across the benchmark's collections, then build this
// variant's indexes and wait for them to finish.
async function resetIndexes(db, collectionNames, indexes) {
    for (const name of collectionNames) {
        await db
            .collection(name)
            .dropIndexes()
            .catch(() => {}); // no-op if only _id
    }
    for (const spec of indexes) {
        await db.collection(spec.on).createIndex(spec.keys, spec.options ?? {});
    }
}

// { find, page?, check } -> "default" variant; { variants: {...} } -> as-is.
// `check` is required on every query variant.
function normalizeQueries(queries) {
    const out = [];
    const add = (group, variant, spec) => {
        if (typeof spec?.find !== "function")
            throw new Error(`query ${group}/${variant}: missing find(db) function`);
        if (typeof spec?.check !== "function")
            throw new Error(`query ${group}/${variant}: missing required check(doc) function`);
        out.push({ group, variant, find: spec.find, page: spec.page, check: spec.check });
    };
    for (const [group, val] of Object.entries(queries)) {
        if (val.variants) for (const [v, spec] of Object.entries(val.variants)) add(group, v, spec);
        else add(group, "default", val);
    }
    return out;
}

// The timed query: find + this variant's skip/limit (the real paginated query).
function runQuery(db, q) {
    let cursor = q.find(db);
    if (q.page?.skip) cursor = cursor.skip(q.page.skip);
    if (q.page?.limit) cursor = cursor.limit(q.page.limit);
    return cursor.toArray();
}

// Accuracy pass — run once per seed variant on the freshly-seeded (index-free)
// collection, so it's a complete COLLSCAN ground truth. Every returned doc must
// pass check(); the full set being complete + all-valid verifies the query. A
// correct index never changes results, so this covers all index variants.
// Throws (aborts the whole run) on the first inaccurate query.
async function verify(db, queries) {
    for (const q of queries) {
        const docs = await q.find(db).toArray(); // full set, no pagination
        const bad = docs.find((d) => !q.check(d));
        if (bad)
            throw new Error(
                `ACCURACY FAILURE — ${q.group}/${q.variant}: doc _id=${JSON.stringify(bad._id)} ` +
                    `failed check(). Benchmark aborted; results would be meaningless.`,
            );
        console.log(`    ✓ ${q.group}/${q.variant}: ${docs.length} docs pass check`);
    }
}

const median = (a) => {
    const s = [...a].sort((x, y) => x - y);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const percentile = (a, p) => {
    const s = [...a].sort((x, y) => x - y);
    return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

async function measure(fn, { warmup, iterations }) {
    for (let i = 0; i < warmup; i++) await fn();
    const t = [];
    for (let i = 0; i < iterations; i++) {
        const start = performance.now();
        await fn();
        t.push(performance.now() - start);
    }
    return { min: Math.min(...t), median: median(t), p95: percentile(t, 95) };
}

export async function runBenchmark(client, name, def, config = {}) {
    const cfg = { ...DEFAULTS, ...config };
    const db = client.db(name);
    const seedVariants = def.seedVariants ?? { default: {} }; // single default if not declared
    const variants = { noIndexes: [], ...def.indexVariants }; // noIndexes reference first
    const queries = normalizeQueries(def.queries);
    const collectionNames = Object.keys(def.collections);
    const results = [];

    for (const [seedVariant, params] of Object.entries(seedVariants)) {
        console.log(`Seed variant: ${seedVariant}`);
        await db.dropDatabase();
        await seed(db, def.collections, cfg.seed, params);
        console.log("  verifying accuracy...");
        await verify(db, queries); // panics before wasting time on inaccurate queries
        for (const [variant, indexes] of Object.entries(variants)) {
            console.log(`  index: ${variant}`);
            await resetIndexes(db, collectionNames, indexes);
            for (const q of queries) {
                const timing = await measure(() => runQuery(db, q), cfg);
                results.push({ seedVariant, query: `${q.group}/${q.variant}`, variant, ...timing });
            }
        }
    }
    return {
        name,
        cfg,
        seedVariants: Object.keys(seedVariants),
        variants: Object.keys(variants),
        results,
    };
}
