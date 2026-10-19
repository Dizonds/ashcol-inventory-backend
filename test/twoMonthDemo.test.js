import test from "node:test";
import assert from "node:assert/strict";
import { demoPeriod, planTwoMonthDemo } from "../scripts/demo/seed-two-month-demo.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { Product, Movement, MovementTicket, User, Supplier } from "../src/database/models.js";

test("demo boundaries cover two calendar months in Manila and clamp month ends", () => {
  assert.deepEqual(demoPeriod(new Date("2026-10-17T04:00:00Z")), {
    start: new Date("2026-08-17T00:00:00+08:00"), end: new Date("2026-10-17T00:00:00+08:00"),
  });
  assert.equal(demoPeriod(new Date("2026-04-30T16:30:00Z")).start.toISOString(), "2026-02-28T16:00:00.000Z");
  assert.equal(demoPeriod(new Date("2026-01-31T04:00:00Z")).start.toISOString(), "2025-11-29T16:00:00.000Z");
});

test("random histories reconcile every item without overdrafts, duplicate times, or future movements", () => {
  for (let run = 1; run <= 100; run += 1) {
    let state = run;
    const random = (min, max) => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return min + state % (max - min); };
    const items = [
      { _id: "ac", quantity: 8, reorderLevel: 3, itemType: "AC Unit" },
      { _id: "parts", quantity: 0, reorderLevel: 5, itemType: "Spare Part" },
      { _id: "tool", quantity: 3, reorderLevel: 1, itemType: "Tool / Equipment" },
      { _id: "hose", quantity: 30, reorderLevel: 8, itemType: "Consumable" },
    ];
    const { activity, balances, start, end } = planTwoMonthDemo(items, { now: new Date("2026-10-17T04:00:00Z"), random });
    assert.ok(activity.length > 200);
    const ledger = new Map(items.map(item => [item._id, item.quantity]));
    let previous = start.getTime();
    for (const entry of activity) {
      assert.ok(entry.createdAt.getTime() > previous && entry.createdAt < end);
      previous = entry.createdAt.getTime();
      assert.equal(entry.beforeQuantity, ledger.get(entry.item._id));
      assert.equal(entry.afterQuantity, entry.beforeQuantity + entry.quantityDelta);
      assert.ok(entry.afterQuantity >= 0 && Number.isInteger(entry.quantityDelta) && entry.quantityDelta !== 0);
      assert.equal(entry.movementType, entry.quantityDelta > 0 ? "STOCK_IN" : "STOCK_OUT");
      ledger.set(entry.item._id, entry.afterQuantity);
    }
    assert.deepEqual(balances, ledger);
    assert.ok(activity.some(entry => entry.quantityDelta > 0));
    assert.ok(activity.some(entry => entry.quantityDelta < 0));
    assert.deepEqual(items.map(item => item.quantity), [8, 0, 3, 30]);
  }
});

test("seed imports reconciled history atomically, preserves accounts and suppliers, and refuses duplicate runs", { timeout: 120000 }, async () => {
  const database = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  try {
    const uri = database.getUri("two_month_demo_test");
    await mongoose.connect(uri);
    await User.create({ email: "manager@example.test", fullName: "Demo Manager", role: "MANAGER", branchId: "LOCAL-WAREHOUSE", passwordHash: "unchanged-test-hash" });
    await Supplier.create({ name: "Concepcion-Carrier Air Conditioning Co.", contactPerson: "Preserve this contact" });
    const originalUsers = await User.collection.find({}).toArray();
    const originalSupplier = await Supplier.collection.findOne({});
    const runSeed = () => promisify(execFile)(process.execPath, [fileURLToPath(new URL("../scripts/demo/seed-two-month-demo.js", import.meta.url))], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), env: { ...process.env, MONGO_URI: uri }, timeout: 60000,
    });
    await runSeed();
    assert.deepEqual(await User.collection.find({}).toArray(), originalUsers);
    assert.deepEqual(await Supplier.collection.findOne({ _id: originalSupplier._id }), originalSupplier);
    const items = await Product.find().lean();
    const movements = await Movement.find().sort({ createdAt: 1, _id: 1 }).lean();
    const tickets = new Map((await MovementTicket.find().lean()).map(ticket => [ticket._id, ticket]));
    const balances = new Map();
    assert.equal(items.length, 18);
    assert.ok(movements.length > 200);
    for (const entry of movements) {
      const key = String(entry.productId);
      assert.equal(entry.beforeQuantity, balances.get(key) || 0);
      assert.equal(entry.afterQuantity, entry.beforeQuantity + entry.quantityDelta);
      assert.ok(entry.afterQuantity >= 0);
      balances.set(key, entry.afterQuantity);
      if (entry.movementType !== "OPENING") {
        const ticket = tickets.get(entry.referenceId);
        assert.equal(ticket.movementType, entry.movementType);
        assert.equal(ticket.usedAt.getTime(), entry.createdAt.getTime());
        assert.equal(ticket.requestedBy, String(originalUsers[0]._id));
        tickets.delete(entry.referenceId);
      }
    }
    assert.equal(tickets.size, 0);
    for (const item of items) assert.equal(item.quantity, balances.get(String(item._id)));
    await assert.rejects(runSeed(), /Inventory already contains data/);
    assert.equal(await Movement.countDocuments(), movements.length);
    assert.deepEqual(await User.collection.find({}).toArray(), originalUsers);
  } finally {
    await mongoose.disconnect();
    await database.stop();
  }
});
