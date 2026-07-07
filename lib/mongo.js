import { execFileSync } from "node:child_process";
import { MongoClient } from "mongodb";

// Returns a connected client. Auto-starts the Docker container unless MONGO_URI
// points somewhere else.
export async function connect() {
    let uri = process.env.MONGO_URI;
    if (!uri) {
        console.log("Starting MongoDB container (docker compose up -d --wait)...");
        execFileSync("docker", ["compose", "up", "-d", "--wait"], { stdio: "inherit" });
        uri = "mongodb://localhost:27018"; // 27017 often taken by a local mongod/container
    }
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000 });
    await client.connect();
    return client;
}
