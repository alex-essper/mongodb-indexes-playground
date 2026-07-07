import { faker } from "@faker-js/faker";

// Seeded PRNG (mulberry32) so seeding is reproducible run-to-run.
export function mulberry32(seed) {
    let s = seed >>> 0;
    return function () {
        s = (s + 0x6d2b79f5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// Build the generator context. `idsByCollection` holds _ids of already-seeded
// collections (insertion order); referencing the collection being seeded is a
// user error (it isn't there yet).
export function makeCtx(seed) {
    const rng = mulberry32(seed);
    faker.seed(seed);
    const idsByCollection = {};

    const idsOf = (name) => {
        const ids = idsByCollection[name];
        if (!ids)
            throw new Error(`ctx.ref('${name}'): collection not seeded yet (seed it earlier)`);
        return ids;
    };

    const ctx = {
        faker,
        int: (min, max) => min + Math.floor(rng() * (max - min + 1)),
        pick: (arr) => arr[Math.floor(rng() * arr.length)],
        maybe: (p, fn) => (rng() < p ? fn() : null),
        chance: (p) => rng() < p, // for conditionally including a field (omit vs null)
        ref: (name, key) => {
            const ids = idsOf(name);
            if (key === undefined) return ids[Math.floor(rng() * ids.length)];
            const v = ids[key];
            if (v === undefined)
                throw new Error(`ctx.ref('${name}', ${key}): out of range (size ${ids.length})`);
            return v;
        },
        refs: (name, n) => {
            const ids = idsOf(name);
            const take = Math.min(n, ids.length);
            const idx = new Set();
            while (idx.size < take) idx.add(Math.floor(rng() * ids.length));
            return [...idx].map((i) => ids[i]);
        },
    };

    return { ctx, idsByCollection };
}
