import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomInt } from "node:crypto";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import { Product, Movement, MovementTicket, Counter, User, Brand, Supplier } from "../../src/database/models.js";

const BRANCH = "LOCAL-WAREHOUSE";
const DAY = 86400000;
const pick = (values, random) => values[random(0, values.length)];

export function demoPeriod(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now).map(({ type, value }) => [type, value]));
  const end = new Date(`${parts.year}-${parts.month}-${parts.day}T00:00:00+08:00`);
  const month = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 3, 1));
  const lastDay = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0)).getUTCDate();
  const start = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), Math.min(Number(parts.day), lastDay)) - 8 * 3600000);
  return { start, end };
}

export function planTwoMonthDemo(items, { now = new Date(), random = randomInt } = {}) {
  if (!items.length) throw new Error("A demo catalog is required.");
  const { start, end } = demoPeriod(now);
  const balances = new Map(items.map(item => [String(item._id), item.quantity]));
  const activity = [];
  const locations = ["Taguig residential installation", "Makati office fit-out", "Pasig clinic maintenance", "Paranaque retail servicing", "Mandaluyong condominium repair", "BGC restaurant installation"];
  for (let day = start.getTime(); day < end.getTime(); day += DAY) {
    const weekday = new Date(day + 8 * 3600000).getUTCDay();
    const count = weekday === 0 ? random(0, 3) : weekday === 6 ? random(2, 7) : random(5, 13);
    const times = Array.from({ length: count }, () => day + random(8 * 3600, 17 * 3600) * 1000).sort((a, b) => a - b);
    for (let index = 0; index < times.length; index += 1) {
      const item = pick(items, random);
      const key = String(item._id);
      const beforeQuantity = balances.get(key);
      const target = Math.max(item.quantity, item.reorderLevel * 3, 4);
      const inbound = beforeQuantity === 0 || (beforeQuantity < target && random(0, 100) < (beforeQuantity <= item.reorderLevel ? 85 : 25));
      const tool = item.itemType === "Tool / Equipment";
      const maximumIssue = tool ? 1 : item.itemType === "AC Unit" ? 2 : item.itemType === "Spare Part" ? 4 : 5;
      const amount = inbound
        ? Math.max(1, Math.round(target * random(60, 111) / 100) - beforeQuantity)
        : Math.min(beforeQuantity, random(1, maximumIssue + 1));
      const quantityDelta = inbound ? amount : -amount;
      const createdAt = new Date(times[index] + index);
      const date = new Date(day + 8 * 3600000).toISOString().slice(0, 10).replaceAll("-", "");
      const referenceNumber = `DEMO-${inbound ? "DR" : "SVC"}-${date}-${String(index + 1).padStart(2, "0")}`;
      const reason = inbound
        ? `Supplier Delivery / Restock: [DEMO] ${item.supplier || "HVAC supplier"}; delivery receipt ${referenceNumber}`
        : tool
          ? `Client Installation / Site Project: [DEMO] equipment issued for ${pick(locations, random)}`
          : `${random(0, 100) < 15 ? "Parts Sale" : "Client Installation / Site Project"}: [DEMO] ${pick(locations, random)}`;
      const afterQuantity = beforeQuantity + quantityDelta;
      balances.set(key, afterQuantity);
      activity.push({ item, quantityDelta, beforeQuantity, afterQuantity, createdAt, referenceNumber, reason, movementType: inbound ? "STOCK_IN" : "STOCK_OUT" });
    }
  }
  return { start, end, activity, balances };
}

async function seed() {
  await mongoose.connect(process.env.MONGO_URI || "mongodb://127.0.0.1:27018/ashcol_inventory?replicaSet=rs0", { serverSelectionTimeoutMS: 5000 });
  try {
    if (await Product.exists({}) || await Movement.exists({})) {
      throw new Error("Inventory already contains data. No changes made; this seed only initializes an empty inventory.");
    }
    const actor = await User.findOne({ branchId: BRANCH, role: "MANAGER" }).lean()
      || await User.findOne({ branchId: BRANCH, role: "ADMIN" }).lean();
    if (!actor) throw new Error("An existing warehouse manager or admin is required.");
    const readTemplate = async name => mongoose.mongo.BSON.EJSON.parse(await fs.readFile(new URL(`../../demo-data/${name}.json`, import.meta.url), "utf8"));
    const templates = (await readTemplate("products")).filter(item => item.branchId === BRANCH && !item.archived);
    const suppliers = await readTemplate("suppliers");
    const { start } = demoPeriod();
    const openingAt = new Date(start.getTime() + 7.5 * 3600000);
    const items = templates.map(template => {
      const { _id, __v, createdAt, updatedAt, priceHistory, ...data } = template;
      return { ...data, _id: new mongoose.Types.ObjectId(), createdAt: openingAt, updatedAt: openingAt, priceHistory: [{ cost: data.unitCost, supplier: data.supplier, date: openingAt, note: "Demo opening stock cost" }] };
    });
    const plan = planTwoMonthDemo(items);
    const backup = {};
    for (const { name, type } of await mongoose.connection.db.listCollections().toArray()) {
      if (type === "collection" && !name.startsWith("system.")) backup[name] = await mongoose.connection.db.collection(name).find({}).toArray();
    }
    const backupDirectory = path.join(process.env.LOCALAPPDATA || os.tmpdir(), "AshcolInventory", "backups");
    await fs.mkdir(backupDirectory, { recursive: true });
    const backupFile = path.join(backupDirectory, `${mongoose.connection.name}-before-two-month-demo-${Date.now()}.json`);
    await fs.writeFile(backupFile, mongoose.mongo.BSON.EJSON.stringify(backup, { relaxed: false }), { flag: "wx" });
    console.log(`Backup saved: ${backupFile}`);
    for (const model of [Product, Movement, MovementTicket, Counter, Brand, Supplier]) await model.init();
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        if (await Product.exists({}).session(session) || await Movement.exists({}).session(session)) throw new Error("Inventory changed while preparing demo data; nothing added.");
        for (const item of items) {
          await Brand.updateOne({ name: item.brand }, { $setOnInsert: { name: item.brand, createdAt: openingAt, updatedAt: openingAt } }, { upsert: true, session, timestamps: false });
          const supplier = suppliers.find(entry => entry.name === item.supplier);
          if (supplier) {
            const { _id, __v, createdAt, updatedAt, ...data } = supplier;
            await Supplier.updateOne({ name: data.name }, { $setOnInsert: { ...data, createdAt: openingAt, updatedAt: openingAt } }, { upsert: true, session, timestamps: false });
          }
        }
        await Product.insertMany(items.map(item => ({ ...item, quantity: plan.balances.get(String(item._id)), updatedAt: plan.activity.filter(entry => entry.item === item).at(-1)?.createdAt || openingAt })), { session });
        const snapshot = item => ({ productId: item._id, branchId: BRANCH, sku: item.sku, itemName: item.name, itemType: item.itemType, category: item.category, brand: item.brand, unitOfMeasure: item.unitOfMeasure, performedBy: String(actor._id), performedByName: actor.fullName });
        await Movement.insertMany(items.map(item => ({ ...snapshot(item), quantityDelta: item.quantity, beforeQuantity: 0, afterQuantity: item.quantity, movementType: "OPENING", reason: "Initial opening stock: [DEMO] two-month sample inventory", createdAt: openingAt, updatedAt: openingAt })), { session });
        const next = {};
        for (const type of ["STOCK_IN", "STOCK_OUT"]) {
          const prefix = type === "STOCK_IN" ? "STI" : "STO";
          const count = plan.activity.filter(entry => entry.movementType === type).length;
          const existingTickets = await MovementTicket.find({ _id: new RegExp(`^${prefix}\\d+$`) }).session(session).lean();
          const highest = Math.max(0, ...existingTickets.map(ticket => Number(ticket._id.slice(3))));
          await Counter.updateOne({ _id: prefix }, { $max: { value: highest } }, { upsert: true, session });
          const counter = await Counter.findOneAndUpdate({ _id: prefix }, { $inc: { value: count } }, { new: true, session });
          next[type] = counter.value - count + 1;
        }
        const tickets = [];
        const movements = plan.activity.map(({ item, ...entry }) => {
          const prefix = entry.movementType === "STOCK_IN" ? "STI" : "STO";
          const referenceId = `${prefix}${String(next[entry.movementType]++).padStart(4, "0")}`;
          tickets.push({ _id: referenceId, movementType: entry.movementType, branchId: BRANCH, requestedBy: String(actor._id), usedAt: entry.createdAt });
          return { ...snapshot(item), ...entry, referenceId, updatedAt: entry.createdAt };
        });
        await MovementTicket.insertMany(tickets, { session });
        await Movement.insertMany(movements, { session });
      });
    } finally { await session.endSession(); }
    console.log(JSON.stringify({ products: items.length, openingRecords: items.length, stockIns: plan.activity.filter(entry => entry.quantityDelta > 0).length, stockOuts: plan.activity.filter(entry => entry.quantityDelta < 0).length, firstActivity: plan.activity[0]?.createdAt, lastActivity: plan.activity.at(-1)?.createdAt, accountsPreserved: true }, null, 2));
  } finally { await mongoose.disconnect(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  seed().catch(error => { console.error(error.message); process.exitCode = 1; });
}
