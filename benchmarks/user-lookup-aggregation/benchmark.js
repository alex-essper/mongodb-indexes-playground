import { ObjectId } from "mongodb";
import { defineBenchmark } from "../../lib/define.js";

export const description =
    "records $lookup users: pipeline shape (lookup-first vs match-first) x index strategy (none / good compound / decoy on the join field)";

export const config = { warmup: 2, iterations: 12, seed: 1 };

export default defineBenchmark({
    collections: {
        users: {
            count: 2_000,
            doc: (i, ctx) => ({
                _id: new ObjectId(), // ObjectId so records reference a real ObjectId
                name: ctx.faker.person.fullName(),
                email: ctx.faker.internet.email(),
                country: ctx.faker.location.countryCode(), // 2-letter; "US" is a small slice
                tier: ctx.pick(["free", "pro", "enterprise"]),
            }),
        },
        records: {
            count: 20_000,
            doc: (i, ctx) => {
                // "suspended" is RARE (~1%). A no-index scan must plow through most of the
                // collection to fill a page of matches; the index jumps straight to them.
                // That gap is where the index earns its keep (and the decoy doesn't).
                const r = ctx.int(0, 99);
                const status = r < 70 ? "active" : r < 88 ? "pending" : r < 99 ? "closed" : "suspended";
                return {
                    _id: i,
                    userId: ctx.ref("users"), // ObjectId reference (random 1-many)
                    status,
                    amount: ctx.int(1, 1000),
                };
            },
        },
    },

    indexVariants: {
        // REALLY GOOD: compound on the match field + the join field. The $match on status
        // is an IXSCAN, and userId (+ implicit _id) live in the index entry, so the local
        // side of the lookup is COVERED — no FETCH before the join fans out.
        good: [{ on: "records", keys: { status: 1, userId: 1 } }],

        // LOOKS RIGHT, DOESN'T WORK: index the join field. Intuition says "index what you
        // join on" — but $lookup resolves the foreign side via users._id (always indexed),
        // and the local userId is read from docs already flowing through the pipeline. The
        // match is on status, which this index doesn't cover → still a COLLSCAN.
        decoy: [{ on: "records", keys: { userId: 1 } }],
    },

    queries: {
        // 1) LOOKUP FIRST (pipeline projects the user), THEN MATCH on the joined field.
        //    The match depends on lookup output, so the optimizer CANNOT push it ahead of
        //    the $lookup — every record gets a lookup before anything is filtered. No index
        //    on records helps here: the shape, not the index, is the bottleneck.
        lookupFirstThenMatch: {
            query: (db) =>
                db.collection("records").aggregate([
                    {
                        $lookup: {
                            from: "users",
                            localField: "userId",
                            foreignField: "_id",
                            pipeline: [{ $project: { name: 1, country: 1, tier: 1 } }],
                            as: "user",
                        },
                    },
                    { $unwind: "$user" },
                    { $match: { "user.country": "US" } },
                    {
                        $project: {
                            _id: 1,
                            status: 1,
                            name: "$user.name",
                            country: "$user.country",
                            tier: "$user.tier",
                        },
                    },
                ]),
            page: { skip: 100, limit: 200 },
            check: (doc) => doc.country === "US" && typeof doc.name === "string",
        },

        // 2) MATCH FIRST, THEN LOOKUP, THEN A SEPARATE $project of user fields.
        //    $match on the record's own status can use the index and cut the set down
        //    before the (now few) lookups run.
        matchThenLookupThenProject: {
            query: (db) =>
                db.collection("records").aggregate([
                    { $match: { status: "suspended" } },
                    {
                        $lookup: {
                            from: "users",
                            localField: "userId",
                            foreignField: "_id",
                            as: "user",
                        },
                    },
                    { $unwind: "$user" },
                    {
                        $project: {
                            _id: 1,
                            status: 1,
                            name: "$user.name",
                            country: "$user.country",
                            tier: "$user.tier",
                        },
                    },
                ]),
            page: { skip: 100, limit: 200 },
            check: (doc) => doc.status === "suspended" && typeof doc.name === "string",
        },

        // 3) MATCH FIRST, THEN LOOKUP WITH THE PROJECTION EMBEDDED in the lookup pipeline.
        //    Same match-first win; projection happens inside the join instead of after it.
        matchThenLookupEmbeddedProject: {
            query: (db) =>
                db.collection("records").aggregate([
                    { $match: { status: "suspended" } },
                    {
                        $lookup: {
                            from: "users",
                            localField: "userId",
                            foreignField: "_id",
                            pipeline: [{ $project: { name: 1, country: 1, tier: 1 } }],
                            as: "user",
                        },
                    },
                    { $unwind: "$user" },
                    { $project: { _id: 1, status: 1, user: 1 } },
                ]),
            page: { skip: 100, limit: 200 },
            check: (doc) =>
                doc.status === "suspended" && doc.user && typeof doc.user.name === "string",
        },
    },
});
