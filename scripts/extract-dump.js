import mongoose from "mongoose";
import fs from "fs";
import path from "path";

const MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27018/ashcol_inventory?replicaSet=rs0";

async function run() {
  const conn = await mongoose.createConnection(MONGO_URI).asPromise();
  console.log("Connected to MongoDB at", MONGO_URI);

  // 1. Ensure LOCAL-WAREHOUSE branch is named "Main Warehouse" and clean up any dangling ObjectId branch
  await conn.db.collection("branches").deleteMany({ _id: { $type: "objectId" } });
  await conn.db.collection("branches").updateOne(
    { _id: "LOCAL-WAREHOUSE" },
    { $set: { name: "Main Warehouse", branchType: "WAREHOUSE", status: "AVAILABLE" } },
    { upsert: true }
  );

  const branches = await conn.db.collection("branches").find().toArray();
  console.log("Current branches:", branches);

  // 2. Export all collections to ashcol_dump/extracted
  const outDir = path.resolve("ashcol_dump/extracted");
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  const collections = await conn.db.listCollections().toArray();
  for (const c of collections) {
    const docs = await conn.db.collection(c.name).find().toArray();
    const filePath = path.join(outDir, `${c.name}.json`);
    fs.writeFileSync(filePath, JSON.stringify(docs, null, 2), "utf8");
    console.log(`Extracted ${docs.length} documents to ${filePath}`);
  }

  await conn.close();
  console.log("Extraction and branch sync completed successfully!");
}

run().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});

