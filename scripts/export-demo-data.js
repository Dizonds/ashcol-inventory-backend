import "dotenv/config";
import mongoose from "mongoose";
import { mkdir, writeFile } from "node:fs/promises";
import { BSON } from "mongodb";
import path from "node:path";

async function main() {
  const uri = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/ashcol_inventory";
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
  const db = mongoose.connection.db;
  const output = path.resolve("demo-data-json");
  await mkdir(output, { recursive: true });
  const counts = {};
  for (const { name, type } of await db.listCollections().toArray()) {
    if (type !== "collection" || name === "sessions" || name.startsWith("system.")) continue;
    const documents = await db.collection(name).find({}).toArray();
    await writeFile(path.join(output, `${name}.json`),
      BSON.EJSON.stringify(documents, null, 2, { relaxed: false }) + "\n");
    counts[name] = documents.length;
  }

  await writeFile(path.join(output, "manifest.json"), JSON.stringify({
    exportedAt: new Date().toISOString(), database: db.databaseName,
    format: "MongoDB Extended JSON (canonical), one array per collection",
    collections: counts, excludedCollections: ["sessions"],
  }, null, 2) + "\n");
  console.log("Exported demo database JSON files to demo-data-json/");
  console.table(counts);
}

main()
  .catch((error) => {
    console.error("Demo export failed:", error.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
