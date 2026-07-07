import { defineBenchmark } from "../../lib/define.js";

export const description =
    "Order lookups: single vs compound vs multikey indexes on a 1-many + m:m dataset.";

export const config = { warmup: 5, iterations: 50, seed: 1 };

export default defineBenchmark({
    collections: {
        // reference data
        tags: {
            count: 200,
            doc: (i) => ({ _id: i, label: `tag-${i}` }),
        },
        users: {
            count: 5_000,
            doc: (i, ctx) => ({ _id: i, name: ctx.faker.person.fullName(), tier: ctx.int(0, 2) }),
        },
        // 100k orders over 5k users (1-many), each with a m:m tag list and an
        // optional coupon (optional 1-1 into users, ~30% present).
        orders: {
            count: 100_000,
            doc: (i, ctx) => ({
                _id: i,
                userId: ctx.ref("users"),
                status: ctx.pick(["open", "paid", "shipped", "cancelled"]),
                total: ctx.int(1, 500),
                tagIds: ctx.refs("tags", ctx.int(0, 5)),
                referredBy: ctx.maybe(0.3, () => ctx.ref("users")),
            }),
        },
    },

    indexVariants: {
        userId: [{ on: "orders", keys: { userId: 1 } }],
        userStatus: [{ on: "orders", keys: { userId: 1, status: 1 } }],
        userTotalSort: [{ on: "orders", keys: { userId: 1, total: -1 } }],
        tagsMultikey: [{ on: "orders", keys: { tagIds: 1 } }],
    },

    queries: {
        byUser: {
            variants: {
                hot: (db) => db.collection("orders").find({ userId: 42 }).toArray(),
                withStatus: (db) =>
                    db.collection("orders").find({ userId: 42, status: "paid" }).toArray(),
            },
        },
        byUserTopSpend: (db) =>
            db.collection("orders").find({ userId: 42 }).sort({ total: -1 }).limit(10).toArray(),
        byTag: (db) => db.collection("orders").find({ tagIds: 7 }).toArray(),
    },
});
