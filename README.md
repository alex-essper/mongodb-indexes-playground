# mongodb-indexes-playground

Benchmark MongoDB query performance under different index strategies.

## Usage

```bash
npm install
npm run benchmarks            # list benchmarks
npm run benchmark orders      # run one (auto-starts MongoDB via Docker)
npm run mongo:down            # stop the container
```

MongoDB 8.0 runs in Docker on host port **27018** (27017 is often taken). Point
elsewhere with `MONGO_URI=mongodb://host:port npm run benchmark orders`.

Each run prints a table and writes `benchmarks/<name>/runs/<timestamp>/{summary.md,results.json}` (gitignored).

## Writing a benchmark

Create `benchmarks/<name>/benchmark.js`:

```js
export const description = "what this tests"; // shown by `npm run benchmarks`
export const config = { warmup: 5, iterations: 50, seed: 1 }; // optional, these are the defaults

export default {
    // Optional: re-seed the data differently per variant. The params object is passed
    // as the 3rd arg to every `doc(i, ctx, params)`. Omit to seed once.
    // Full matrix run = seedVariant x indexVariant x query; one result table per seed variant.
    seedVariants: {
        none: { sourceRatio: 0 },
        half: { sourceRatio: 0.5 },
    },

    // Collections seed in order. Later ones can reference earlier ones via ctx.
    collections: {
        tags: { count: 200, doc: (i, ctx) => ({ _id: i, label: `tag-${i}` }) },
        users: { count: 5_000, doc: (i, ctx) => ({ _id: i, name: ctx.faker.person.fullName() }) },
        orders: {
            count: 100_000,
            doc: (i, ctx) => ({
                _id: i,
                userId: ctx.ref("users"), // random 1-many
                tagIds: ctx.refs("tags", ctx.int(0, 5)), // many-to-many (distinct array)
                referredBy: ctx.maybe(0.3, () => ctx.ref("users")), // optional
            }),
        },
    },

    // A `noIndexes` variant is auto-added as the reference column.
    indexVariants: {
        userId: [{ on: "orders", keys: { userId: 1 } }],
        compound: [{ on: "orders", keys: { userId: 1, total: -1 }, options: {} }],
    },

    // Each query is { query, page?, check }, or { variants: { name: {...} } }.
    // query = (db) => a cursor, find OR aggregation, minus pagination. Don't materialize.
    //         e.g. db.collection(x).find({...})  or  .aggregate([...]) (no $skip/$limit).
    // page  = skip/limit for the TIMED run only (stripped for the accuracy pass;
    //         works on both find and aggregation cursors).
    // check = REQUIRED; run on every doc of the full result — false aborts the run.
    // Every query variant runs against every index variant.
    queries: {
        byUser: {
            variants: {
                hot: {
                    query: (db) => db.collection("orders").find({ userId: 42 }),
                    check: (doc) => doc.userId === 42,
                },
                cold: {
                    query: (db) => db.collection("orders").find({ userId: 4999 }),
                    check: (doc) => doc.userId === 4999,
                },
            },
        },
        top: {
            query: (db) => db.collection("orders").find().sort({ total: -1 }),
            page: { limit: 10 },
            check: (doc) => doc != null,
        },
    },
};
```

Aggregation query (put pagination in `page`, not as `$skip`/`$limit` stages, so the
accuracy pass can strip it):

```js
topKinds: {
    query: (db) =>
        db.collection("records").aggregate([
            { $group: { _id: "$kind", total: { $sum: "$n" } } },
            { $sort: { total: -1 } },
        ]),
    page: { limit: 10 },
    check: (doc) => typeof doc.total === "number",
},
```

### `ctx` helpers (all seeded/deterministic)

| helper                               | purpose                                                                            |
| ------------------------------------ | ---------------------------------------------------------------------------------- |
| `ctx.ref(name)`                      | random `_id` from a seeded collection (random 1-many)                              |
| `ctx.ref(name, key)`                 | `_id` at position `key` (strict 1-1 / controlled fan-out)                          |
| `ctx.refs(name, n)`                  | array of `n` distinct random `_id`s (many-to-many)                                 |
| `ctx.maybe(p, fn)`                   | `fn()` with probability `p`, else `null` (optional relationships)                  |
| `ctx.chance(p)`                      | boolean, true with probability `p` — use to **omit** a field (vs `maybe`'s `null`) |
| `ctx.int(min, max)`, `ctx.pick(arr)` | seeded primitives                                                                  |
| `ctx.faker`                          | seeded [@faker-js/faker](https://fakerjs.dev)                                      |

The runner, per seed variant: drops the DB, seeds, then runs an **accuracy pass** —
each query's full `find` (no pagination) on the index-free collection is a complete
COLLSCAN ground truth; every doc must pass `check` or the whole run aborts. Then per
index variant it drops all indexes, builds that variant's, and times each query
(warmup discarded, then `iterations` runs → min/median/p95). Because a correct index
never changes results, verifying once per seed variant covers every index variant.
See `benchmarks/orders/` for a full example.
