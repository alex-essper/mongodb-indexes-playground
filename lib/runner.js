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

// { query, page?, check } -> "default" variant; { variants: {...} } -> as-is.
// `query` returns a cursor — find OR aggregation, the runner treats them the same.
// `check` is required on every query variant.
function normalizeQueries(queries) {
    const out = [];
    const add = (group, variant, spec) => {
        if (typeof spec?.query !== "function")
            throw new Error(`query ${group}/${variant}: needs a query(db) function returning a cursor`);
        if (typeof spec?.check !== "function")
            throw new Error(`query ${group}/${variant}: missing required check(doc) function`);
        out.push({ group, variant, query: spec.query, page: spec.page, check: spec.check });
    };
    for (const [group, val] of Object.entries(queries)) {
        if (val.variants) for (const [v, spec] of Object.entries(val.variants)) add(group, v, spec);
        else add(group, "default", val);
    }
    return out;
}

// The real paginated query: cursor + this variant's skip/limit. skip/limit work
// on both find and aggregation cursors.
function buildCursor(db, q) {
    let cursor = q.query(db);
    if (q.page?.skip) cursor = cursor.skip(q.page.skip);
    if (q.page?.limit) cursor = cursor.limit(q.page.limit);
    return cursor;
}
const runQuery = (db, q) => buildCursor(db, q).toArray();

// Pull the honing-relevant bits out of explain('executionStats'). Recurses so it
// works for find plans and aggregation ($cursor) plans alike, and collects EVERY
// scan (so parallel IXSCANs under an $or/SUBPLAN are all surfaced).
function summarizeExplain(x) {
    const es = x.executionStats ?? x.stages?.[0]?.$cursor?.executionStats;
    const wp = x.queryPlanner?.winningPlan ?? x.stages?.[0]?.$cursor?.queryPlanner?.winningPlan;
    const indexes = [];
    let collscan = false;
    const walk = (n) => {
        if (!n || typeof n !== "object") return;
        if (n.stage === "IXSCAN" && n.indexName) indexes.push(n.indexName);
        if (n.stage === "COLLSCAN") collscan = true;
        walk(n.inputStage);
        (n.inputStages ?? []).forEach(walk);
    };
    walk(wp);
    const ix = [...new Set(indexes)];
    let stage;
    if (collscan && ix.length) stage = `COLL+IXx${ix.length}`;
    else if (collscan) stage = "COLLSCAN";
    else if (ix.length > 1) stage = `IXSCANx${ix.length}`;
    else if (ix.length === 1) stage = "IXSCAN";
    else stage = wp?.stage ?? "?";
    return {
        stage,
        indexes: ix,
        docsExamined: es?.totalDocsExamined,
        keysExamined: es?.totalKeysExamined,
        nReturned: es?.nReturned,
    };
}
const explainQuery = (db, q) => buildCursor(db, q).explain("executionStats");

// Accuracy pass — run once per seed variant on the freshly-seeded (index-free)
// collection, so it's a complete COLLSCAN ground truth. Every returned doc must
// pass check(); the full set being complete + all-valid verifies the query. A
// correct index never changes results, so this covers all index variants.
// Throws (aborts the whole run) on the first inaccurate query.
async function verify(db, queries) {
    for (const q of queries) {
        const docs = await q.query(db).toArray(); // full set, no pagination
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
                const plan = summarizeExplain(await explainQuery(db, q));
                results.push({ seedVariant, query: `${q.group}/${q.variant}`, variant, ...timing, plan });
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
