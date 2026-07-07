import { defineBenchmark } from "../../lib/define.js";

export const description =
    "status split across two indexed fields: $or-first (parallel IXSCAN) vs $addFields-first (loses the index), plus $exists:false vs null when explicit nulls exist";

export default defineBenchmark({
    collections: {
        records: {
            count: 300_000,
            doc: (i, ctx, _v) => {
                // Skewed so approved/pending are selective — that's when the index earns
                // its keep and $addFields-first (a full scan) visibly suffers.
                const r = ctx.int(0, 99);
                const value = r < 85 ? "declined" : r < 92 ? "approved" : "pending";

                // Where the status lives — and crucially, EXPLICIT NULL vs MISSING as two
                // distinct "unset" shapes, so $exists:false and null diverge.
                switch (ctx.pick(["both", "baseOnly", "nestedOnly", "missing", "explicitNull"])) {
                    case "both":
                        return { _id: i, status: value, nestedStatus: { status: value } };
                    case "baseOnly":
                        return { _id: i, status: value };
                    case "nestedOnly":
                        return { _id: i, nestedStatus: { status: value } };
                    case "explicitNull":
                        return { _id: i, status: null, nestedStatus: { status: null } };
                    case "missing":
                    default:
                        return { _id: i };
                }
            },
        },
    },

    // The two sources each get their own index (the scenario being tested).
    indexVariants: {
        bothStatuses: [
            { on: "records", keys: { status: 1 } },
            { on: "records", keys: { "nestedStatus.status": 1 } },
        ],
    },

    queries: {
        // HEADLINE: identical results, two pipeline shapes.
        // orFirst  -> $match first, planner uses parallel IXSCANs, then normalize.
        // addFieldsFirst -> normalize first, $match can't push to the index -> COLLSCAN.
        pending: {
            variants: {
                orFirst: {
                    query: (db) =>
                        db.collection("records").aggregate([
                            {
                                $match: {
                                    $or: [
                                        { status: "pending" },
                                        { "nestedStatus.status": "pending" },
                                    ],
                                },
                            },
                            {
                                $addFields: {
                                    status: { $ifNull: ["$nestedStatus.status", "$status"] },
                                },
                            },
                        ]),
                    page: { skip: 2000, limit: 500 },
                    check: (doc) => doc.status === "pending",
                },
                addFieldsFirst: {
                    query: (db) =>
                        db.collection("records").aggregate([
                            {
                                $addFields: {
                                    status: { $ifNull: ["$nestedStatus.status", "$status"] },
                                },
                            },
                            { $match: { status: "pending" } },
                        ]),
                    page: { skip: 2000, limit: 500 },
                    check: (doc) => doc.status === "pending",
                },
            },
        },

        // "approved OR unset" — unset expressed two ways. With explicit nulls in the
        // data these are NOT equivalent and cost differently:
        //   null        -> IXSCAN returns the null bucket exactly (missing + explicit null).
        //   $exists:false-> IXSCAN the null bucket then FETCH-filters out explicit nulls
        //                   (examines more than it returns).
        // addFieldsFirst_null is the "lost index" reference.
        approvedOrUnset: {
            variants: {
                orFirst_null: {
                    query: (db) =>
                        db.collection("records").aggregate([
                            {
                                $match: {
                                    $or: [
                                        { status: "approved" },
                                        { "nestedStatus.status": "approved" },
                                        {
                                            $and: [
                                                { status: null },
                                                { "nestedStatus.status": null },
                                            ],
                                        },
                                    ],
                                },
                            },
                            {
                                $addFields: {
                                    status: { $ifNull: ["$nestedStatus.status", "$status"] },
                                },
                            },
                        ]),
                    page: { skip: 2000, limit: 500 },
                    check: (doc) => !doc.status || doc.status === "approved",
                },
                orFirst_existsFalse: {
                    query: (db) =>
                        db.collection("records").aggregate([
                            {
                                $match: {
                                    $or: [
                                        { status: "approved" },
                                        { "nestedStatus.status": "approved" },
                                        {
                                            $and: [
                                                { status: { $exists: false } },
                                                { "nestedStatus.status": { $exists: false } },
                                            ],
                                        },
                                    ],
                                },
                            },
                            {
                                $addFields: {
                                    status: { $ifNull: ["$nestedStatus.status", "$status"] },
                                },
                            },
                        ]),
                    page: { skip: 2000, limit: 500 },
                    check: (doc) => !doc.status || doc.status === "approved",
                },
                addFieldsFirst_null: {
                    query: (db) =>
                        db.collection("records").aggregate([
                            {
                                $addFields: {
                                    status: { $ifNull: ["$nestedStatus.status", "$status"] },
                                },
                            },
                            { $match: { $or: [{ status: "approved" }, { status: null }] } },
                        ]),
                    page: { skip: 2000, limit: 500 },
                    check: (doc) => !doc.status || doc.status === "approved",
                },
            },
        },
    },
});
