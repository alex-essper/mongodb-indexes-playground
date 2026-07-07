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
function timingCell(t, base) {
    if (!t) return "-";
    if (!base || t.variant === "noIndexes") return ms(t.median);
    return `${ms(t.median)} (${(base.median / t.median).toFixed(1)}x)`;
}
// query plan summary: stage + docsExamined→nReturned (full detail in results.json)
function planCell(t) {
    if (!t?.plan) return "-";
    const p = t.plan;
    return `${p.stage} ${p.docsExamined ?? "?"}→${p.nReturned ?? "?"}`;
}

function table(rows, cols, fmt) {
    const grid = pivot(rows);
    const header = ["query", ...cols];
    const lines = [header];
    for (const [query, byVariant] of grid) {
        lines.push([query, ...cols.map((c) => fmt(byVariant[c], byVariant.noIndexes))]);
    }
    const widths = header.map((_, i) => Math.max(...lines.map((l) => String(l[i]).length)));
    return lines.map((l) => l.map((v, i) => String(v).padEnd(widths[i])).join("  |  ")).join("\n");
}

function mdTable(rows, cols, fmt) {
    const grid = pivot(rows);
    const out = [
        `| query | ${cols.join(" | ")} |`,
        `| --- | ${cols.map(() => "---").join(" | ")} |`,
    ];
    for (const [query, byVariant] of grid) {
        out.push(`| ${query} | ${cols.map((c) => fmt(byVariant[c], byVariant.noIndexes)).join(" | ")} |`);
    }
    return out.join("\n");
}

// A seed variant is worth labelling unless it's the implicit single "default".
const labelled = (result) =>
    !(result.seedVariants.length === 1 && result.seedVariants[0] === "default");

// Prints table(s) and writes summary.md + results.json to runs/<timestamp>/.
export function report(benchmarkDir, result) {
    const cols = result.variants;
    for (const sv of result.seedVariants) {
        const rows = result.results.filter((r) => r.seedVariant === sv);
        if (labelled(result)) console.log(`\nSeed variant: ${sv}`);
        console.log("\n  timing — median (speedup vs noIndexes):\n");
        console.log(table(rows, cols, timingCell));
        console.log("\n  plan — stage, docsExamined→nReturned:\n");
        console.log(table(rows, cols, planCell) + "\n");
    }

    const md = [
        `# ${result.name}`,
        "",
        `- iterations: ${result.cfg.iterations}, warmup: ${result.cfg.warmup}, seed: ${result.cfg.seed}`,
        "",
    ];
    for (const sv of result.seedVariants) {
        const rows = result.results.filter((r) => r.seedVariant === sv);
        if (labelled(result)) md.push(`## seed: ${sv}`, "");
        md.push("**timing** — median (speedup vs noIndexes):", "", mdTable(rows, cols, timingCell), "");
        md.push("**plan** — stage, docsExamined→nReturned:", "", mdTable(rows, cols, planCell), "");
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dir = join(benchmarkDir, "runs", stamp);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "results.json"), JSON.stringify(result, null, 2));
    writeFileSync(join(dir, "summary.md"), md.join("\n") + "\n");
    console.log(`Wrote ${join(dir, "summary.md")} and results.json`);
}
