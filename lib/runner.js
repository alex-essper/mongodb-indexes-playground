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

// bare function -> single "default" variant; { variants: {...} } -> as-is.
function normalizeQueries(queries) {
    const out = [];
    for (const [group, val] of Object.entries(queries)) {
        if (typeof val === "function") out.push({ group, variant: "default", fn: val });
        else
            for (const [variant, fn] of Object.entries(val.variants))
                out.push({ group, variant, fn });
    }
    return out;
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
        for (const [variant, indexes] of Object.entries(variants)) {
            console.log(`  index: ${variant}`);
            await resetIndexes(db, collectionNames, indexes);
            for (const q of queries) {
                const timing = await measure(() => q.fn(db), cfg);
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
