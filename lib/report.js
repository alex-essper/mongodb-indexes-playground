import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Group a flat list of result rows into { query -> { variant -> timing } }.
function pivot(rows) {
    const out = new Map();
    for (const r of rows) {
        if (!out.has(r.query)) out.set(r.query, {});
        out.get(r.query)[r.variant] = r;
    }
    return out;
}

const ms = (n) => `${n.toFixed(2)}ms`;
// speedup of a variant vs the noIndexes baseline, formatted for a cell
function cell(t, base) {
    if (!t) return "-";
    if (!base || t.variant === "noIndexes") return ms(t.median);
    return `${ms(t.median)} (${(base.median / t.median).toFixed(1)}x)`;
}

function table(rows, cols) {
    const grid = pivot(rows);
    const header = ["query", ...cols];
    const lines = [header];
    for (const [query, byVariant] of grid) {
        const base = byVariant.noIndexes;
        lines.push([query, ...cols.map((c) => cell(byVariant[c], base))]);
    }
    const widths = header.map((_, i) => Math.max(...lines.map((l) => String(l[i]).length)));
    return lines.map((l) => l.map((v, i) => String(v).padEnd(widths[i])).join("  |  ")).join("\n");
}

function mdTable(rows, cols) {
    const grid = pivot(rows);
    const out = [
        `| query | ${cols.join(" | ")} |`,
        `| --- | ${cols.map(() => "---").join(" | ")} |`,
    ];
    for (const [query, byVariant] of grid) {
        const base = byVariant.noIndexes;
        out.push(`| ${query} | ${cols.map((c) => cell(byVariant[c], base)).join(" | ")} |`);
    }
    return out.join("\n");
}

// A seed variant is worth labelling unless it's the implicit single "default".
const labelled = (result) =>
    !(result.seedVariants.length === 1 && result.seedVariants[0] === "default");

// Prints table(s) and writes summary.md + results.json to runs/<timestamp>/.
export function report(benchmarkDir, result) {
    for (const sv of result.seedVariants) {
        const rows = result.results.filter((r) => r.seedVariant === sv);
        if (labelled(result)) console.log(`\nSeed variant: ${sv}`);
        console.log("\n" + table(rows, result.variants) + "\n");
    }

    const md = [
        `# ${result.name}`,
        "",
        `- iterations: ${result.cfg.iterations}, warmup: ${result.cfg.warmup}, seed: ${result.cfg.seed}`,
        "- cell = median (speedup vs noIndexes)",
        "",
    ];
    for (const sv of result.seedVariants) {
        const rows = result.results.filter((r) => r.seedVariant === sv);
        if (labelled(result)) md.push(`## seed: ${sv}`, "");
        md.push(mdTable(rows, result.variants), "");
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dir = join(benchmarkDir, "runs", stamp);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "results.json"), JSON.stringify(result, null, 2));
    writeFileSync(join(dir, "summary.md"), md.join("\n") + "\n");
    console.log(`Wrote ${join(dir, "summary.md")} and results.json`);
}
