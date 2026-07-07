import { test } from "node:test";
import assert from "node:assert/strict";
import { makeCtx } from "./ctx.js";

test("same seed produces identical sequences", () => {
    const a = makeCtx(7).ctx;
    const b = makeCtx(7).ctx;
    const seqA = Array.from({ length: 20 }, () => a.int(0, 1000));
    const seqB = Array.from({ length: 20 }, () => b.int(0, 1000));
    assert.deepEqual(seqA, seqB);
});

test("ref requires an already-seeded collection", () => {
    const { ctx } = makeCtx(1);
    assert.throws(() => ctx.ref("users"), /not seeded yet/);
});

test("ref by key is deterministic, refs are distinct", () => {
    const { ctx, idsByCollection } = makeCtx(1);
    idsByCollection.users = [10, 20, 30, 40, 50];
    assert.equal(ctx.ref("users", 2), 30);
    const picked = ctx.refs("users", 3);
    assert.equal(picked.length, 3);
    assert.equal(new Set(picked).size, 3, "refs must be distinct");
    assert.throws(() => ctx.ref("users", 99), /out of range/);
});

test("refs caps at collection size", () => {
    const { ctx, idsByCollection } = makeCtx(1);
    idsByCollection.tags = [1, 2];
    assert.equal(ctx.refs("tags", 10).length, 2);
});

test("chance is roughly the given probability", () => {
    const { ctx } = makeCtx(1);
    let hits = 0;
    for (let i = 0; i < 1000; i++) if (ctx.chance(0.9)) hits++;
    assert.ok(hits > 850 && hits < 950, `expected ~90%, got ${hits / 10}%`);
});

test("maybe returns null below probability", () => {
    const { ctx } = makeCtx(1);
    let nulls = 0;
    for (let i = 0; i < 1000; i++) if (ctx.maybe(0.3, () => 1) === null) nulls++;
    assert.ok(nulls > 600 && nulls < 800, `expected ~70% null, got ${nulls / 10}%`);
});
