import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import mongoose from "mongoose";
import { Product, Movement, MovementTicket } from "../src/models.js";
import { reserveMovementTicket } from "../src/movement-tickets.js";
import { planDemoActivity } from "./demo-activity.js";

await mongoose.connect(process.env.MONGO_URI || "mongodb://127.0.0.1:27017/ashcol_inventory?replicaSet=rs0");
try {
  const products = await Product.find().lean();
  const original = await Movement.find().sort({ createdAt: 1, _id: 1 }).lean();
  const replaceable = (entry) => entry.branchId === "LOCAL-WAREHOUSE" &&
    ["STOCK_IN", "STOCK_OUT"].includes(entry.movementType) &&
    (["Supplier replenishment", "Client installation / service dispatch"].includes(entry.reason) ||
      String(entry.reason).startsWith("Demo activity:"));
  const removed = original.filter(replaceable);
  if (!removed.length) throw new Error("No seeded demo activity found; refusing to replace other ledger records.");
  const opening = new Map(original.filter((entry) => entry.movementType === "OPENING")
    .map((entry) => [String(entry.productId), entry.quantityDelta]));
  const items = products.filter((item) => item.branchId === "LOCAL-WAREHOUSE" && opening.has(String(item._id)))
    .map((item) => ({ ...item, quantity: opening.get(String(item._id)) }));
  const todayKey = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const dayAt = (daysAgo, hour = 10) => new Date(new Date(`${todayKey}T00:00:00+08:00`).getTime() - daysAgo * 86400000 + hour * 3600000);
  const plan = planDemoActivity(items, dayAt);
  const created = plan.map(({ item, delta, movementType, reason, createdAt }) => ({
    _id: new mongoose.Types.ObjectId(), productId: item._id, branchId: item.branchId,
    sku: item.sku, itemName: item.name, itemType: item.itemType, category: item.category,
    brand: item.brand, unitOfMeasure: item.unitOfMeasure, quantityDelta: delta,
    movementType, reason, createdAt,
    performedBy: removed[0].performedBy, performedByName: removed[0].performedByName,
  }));
  const history = [...original.filter((entry) => !replaceable(entry)), ...created]
    .sort((a, b) => a.createdAt - b.createdAt || String(a._id).localeCompare(String(b._id)));
  const balances = new Map();
  for (const entry of history) {
    const key = String(entry.productId);
    entry.beforeQuantity = balances.get(key) || 0;
    entry.afterQuantity = entry.beforeQuantity + entry.quantityDelta;
    if (entry.afterQuantity < 0) throw new Error(`Randomized history would overdraw ${entry.sku}; no data changed.`);
    balances.set(key, entry.afterQuantity);
  }

  const backup = {};
  for (const collection of await mongoose.connection.db.listCollections().toArray()) {
    backup[collection.name] = await mongoose.connection.db.collection(collection.name).find({}).toArray();
  }
  const backupDirectory = path.join(process.env.LOCALAPPDATA || os.tmpdir(), "AshcolInventory", "backups");
  await fs.mkdir(backupDirectory, { recursive: true });
  const backupFile = path.join(backupDirectory, `${mongoose.connection.name}-before-randomize-${Date.now()}.json`);
  await fs.writeFile(backupFile, mongoose.mongo.BSON.EJSON.stringify(backup, { relaxed: false }), { flag: "wx" });
  console.log(`Backup saved: ${backupFile}`);

  for (const entry of created) {
    const ticket = await reserveMovementTicket(entry.movementType, entry.performedBy);
    entry.referenceId = ticket._id;
  }
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await Movement.deleteMany({ _id: { $in: removed.map((entry) => entry._id) } }, { session });
      await Movement.insertMany(created, { session });
      await Movement.bulkWrite(history.filter((entry) => !created.includes(entry)).map((entry) => ({
        updateOne: { filter: { _id: entry._id }, update: { $set: {
          beforeQuantity: entry.beforeQuantity, afterQuantity: entry.afterQuantity,
        } } },
      })), { session });
      for (const item of products) {
        if (!balances.has(String(item._id))) continue;
        const result = await Product.updateOne({ _id: item._id, __v: item.__v }, {
          $set: { quantity: balances.get(String(item._id)) }, $inc: { __v: 1 },
        }, { session });
        if (result.matchedCount !== 1) throw new Error("Inventory changed during randomization; transaction rolled back.");
      }
      for (const entry of created) await MovementTicket.updateOne({ _id: entry.referenceId }, {
        $set: { usedAt: entry.createdAt },
      }, { session });
    });
  } finally { await session.endSession(); }
  console.log(`Replaced ${removed.length} repetitive movements with ${created.length} randomized records. Accounts and requests preserved.`);
} finally { await mongoose.disconnect(); }
