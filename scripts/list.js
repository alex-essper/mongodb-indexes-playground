import { listBenchmarks, loadBenchmark } from "../lib/discover.js";

const names = listBenchmarks();
if (!names.length) {
    console.log("No benchmarks found in benchmarks/.");
    process.exit(0);
}
console.log("Available benchmarks:\n");
for (const name of names) {
    const { description } = await loadBenchmark(name);
    console.log(`  ${name}${description ? `  —  ${description}` : ""}`);
}
console.log("\nRun one with:  npm run benchmark <name>");
