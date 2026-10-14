import "dotenv/config";
import mongoose from "mongoose";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

async function main() {
  const uri = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/ashcol_inventory";
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
  const db = mongoose.connection.db;
  const output = path.resolve("demo-data");
  await mkdir(output, { recursive: true });
  const counts = {};
  for (const { name, type } of await db.listCollections().toArray()) {
    if (type !== "collection" || name === "sessions" || name.startsWith("system.")) continue;
    counts[name] = await db.collection(name).countDocuments();
  }

  const windowsTool = path.join(process.env.ProgramFiles || "C:/Program Files", "MongoDB/Tools/100/bin/mongodump.exe");
  const executable = existsSync(windowsTool) ? windowsTool : "mongodump";
  const result = spawnSync(executable, [
    `--uri=${uri}`,
    `--db=${db.databaseName}`,
    `--archive=${path.join(output, "ashcol-demo.archive.gz")}`,
    "--gzip",
    "--excludeCollection=sessions",
  ], { encoding: "utf8", windowsHide: true });
  if (result.error || result.status !== 0) {
    throw new Error("mongodump failed. Check MongoDB Database Tools installation and database access.");
  }
  await writeFile(path.join(output, "manifest.json"), JSON.stringify({
    exportedAt: new Date().toISOString(), database: db.databaseName,
    collections: counts, excludedCollections: ["sessions"],
  }, null, 2) + "\n");
  console.log("Exported demo database to demo-data/ashcol-demo.archive.gz");
  console.table(counts);
}

main()
  .catch((error) => {
    console.error("Demo export failed:", error.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
