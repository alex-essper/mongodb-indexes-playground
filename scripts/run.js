import { listBenchmarks, loadBenchmark, nearest } from "../lib/discover.js";
import { connect } from "../lib/mongo.js";
import { runBenchmark } from "../lib/runner.js";
import { report } from "../lib/report.js";

const name = process.argv[2];
const names = listBenchmarks();

if (!name || !names.includes(name)) {
    if (name) {
        const guess = nearest(name, names);
        console.error(`Unknown benchmark "${name}".${guess ? ` Did you mean "${guess}"?` : ""}\n`);
    }
    console.error("Available benchmarks:");
    for (const n of names) console.error(`  ${n}`);
    console.error("\nUsage: npm run benchmark <name>");
    process.exit(1);
}

const { dir, def, config } = await loadBenchmark(name);
const client = await connect();
try {
    const result = await runBenchmark(client, name, def, config);
    report(dir, result);
} finally {
    await client.close();
}
