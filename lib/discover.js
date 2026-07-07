import { readdirSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

export const BENCH_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "benchmarks");

export function listBenchmarks() {
    if (!existsSync(BENCH_ROOT)) return [];
    return readdirSync(BENCH_ROOT, { withFileTypes: true })
        .filter((d) => d.isDirectory() && existsSync(join(BENCH_ROOT, d.name, "benchmark.js")))
        .map((d) => d.name)
        .sort();
}

export async function loadBenchmark(name) {
    const dir = join(BENCH_ROOT, name);
    const mod = await import(pathToFileURL(join(dir, "benchmark.js")));
    return { dir, def: mod.default, config: mod.config, description: mod.description };
}

// crude edit distance for did-you-mean
export function nearest(name, names) {
    const d = (a, b) => {
        const m = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
        for (let j = 0; j <= b.length; j++) m[0][j] = j;
        for (let i = 1; i <= a.length; i++)
            for (let j = 1; j <= b.length; j++)
                m[i][j] = Math.min(
                    m[i - 1][j] + 1,
                    m[i][j - 1] + 1,
                    m[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
                );
        return m[a.length][b.length];
    };
    return names.map((n) => [n, d(name, n)]).sort((x, y) => x[1] - y[1])[0]?.[0];
}
