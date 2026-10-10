// Browser verification only: starts a disposable database and local test server.
// Does not load .env or connect to the user's inventory database.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import express from "express";
import mongoose from "mongoose";
import { chromium } from "playwright-core";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import app from "../src/app.js";
import { initializeDatabase } from "../src/setup.js";
import { User, Branch, Product } from "../src/models.js";
import { hashPassword } from "../src/auth.js";

let database, server, browser;
try {
  database = await MongoMemoryReplSet.create({
    replSet: { count: 1 },
    binary: { version: "7.0.14" },
  });
  await mongoose.connect(database.getUri(), { dbName: "browser_smoke" });
  await initializeDatabase();
  await Branch.create({ _id: "LOCAL-SECOND", name: "Second Demo Branch" });
  await User.create({
    email: "review@example.test",
    fullName: "Inventory Reviewer",
    role: "ADMIN",
    branchId: "LOCAL-WAREHOUSE",
    passwordHash: await hashPassword("Temporary-test-2026"),
  });
  await User.create({
    email: "staff@example.test",
    fullName: "Demo Technician",
    role: "EMPLOYEE",
    branchId: "LOCAL-WAREHOUSE",
    passwordHash: await hashPassword("Temporary-test-2026"),
  });
  const web = express();
  web.use((req, res, next) =>
    req.path.startsWith("/api/") ? app(req, res, next) : next(),
  );
  web.use(express.static(path.resolve("../ashcolinventory/build")));
  server = await new Promise((resolve) => {
    const listener = web.listen(0, "127.0.0.1", () => resolve(listener));
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({
    executablePath:
      process.env.BROWSER_PATH ||
      "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    headless: true,
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(url);
  await page.getByLabel("Work email").fill("review@example.test");
  await page
    .getByLabel("Password", { exact: true })
    .fill("Temporary-test-2026");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page
    .getByRole("heading", { name: "Branch Inventory Overview" })
    .waitFor();
  await page
    .getByRole("button", { name: "Inventory Catalog", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Register Item", exact: true })
    .click();
  await page.getByLabel("SKU / model", { exact: true }).fill("DEMO-AC-01");
  await page
    .getByLabel("Item name", { exact: true })
    .fill("Carrier Split Type 1 HP");
  await page
    .getByLabel("Capacity / specification", { exact: true })
    .fill("1 HP");
  await page.getByLabel("Opening quantity", { exact: true }).fill("5");
  await page.getByLabel("Unit cost (PHP)", { exact: true }).fill("18000");
  await page.getByLabel("Selling price (PHP)", { exact: true }).fill("22000");
  await page
    .getByLabel("Reorder level (zero allowed)", { exact: true })
    .fill("0");
  await page.getByRole("button", { name: "Save item", exact: true }).click();
  await page.getByRole("cell", { name: "DEMO-AC-01", exact: true }).waitFor();
  assert.equal((await Product.findOne({ sku: "DEMO-AC-01" })).reorderLevel, 0);
  await page
    .getByRole("button", { name: "Material Requests", exact: true })
    .click();
  await page.getByRole("button", { name: "New Request", exact: true }).click();
  await page.getByLabel("Item", { exact: true }).click();
  await page
    .getByText("DEMO-AC-01 — Carrier Split Type 1 HP (UNIT)", { exact: true })
    .click();
  await page
    .getByLabel("Job / work-order reference", { exact: true })
    .fill("AC-001");
  await page.getByLabel("Quantity", { exact: true }).fill("2");
  await page
    .getByRole("button", { name: "Submit request", exact: true })
    .click();
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await page.getByRole("button", { name: "Fulfill", exact: true }).click();
  await page.getByRole("button", { name: "OK", exact: true }).click();
  await page.getByText("FULFILLED", { exact: true }).waitFor();
  assert.equal((await Product.findOne({ sku: "DEMO-AC-01" })).quantity, 3);
  await page.getByRole("button", { name: "Stock Ledger", exact: true }).click();
  await page.getByText("REQUEST_ISSUE", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  await page.getByText("3 UNIT", { exact: true }).first().waitFor();
  fs.mkdirSync("../artifacts", { recursive: true });
  await page.screenshot({
    path: "../artifacts/inventory-desktop.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Dark theme", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "../artifacts/inventory-mobile.png",
    fullPage: true,
  });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  assert.equal(overflow, false, "Mobile page must not overflow horizontally");
  await page.getByRole("button", { name: "Log out", exact: true }).click();
  await page.reload();
  await page.getByRole("button", { name: "Sign in", exact: true }).waitFor();
  await page.getByLabel("Work email").fill("staff@example.test");
  await page
    .getByLabel("Password", { exact: true })
    .fill("Temporary-test-2026");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page
    .getByRole("heading", { name: "Branch Inventory Overview" })
    .waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Post Movement", exact: true })
      .count(),
    0,
  );
  await page
    .getByRole("button", { name: "Inventory Catalog", exact: true })
    .click();
  assert.equal(
    await page.getByRole("button", { name: "Edit", exact: true }).count(),
    0,
  );
  await page.getByRole("button", { name: "Specs", exact: true }).click();
  await page.getByText("Item specifications", { exact: true }).waitFor();
  assert.equal(
    await page.getByRole("button", { name: "Save item", exact: true }).count(),
    0,
  );
  assert.deepEqual(errors, []);
  console.log(
    "Browser smoke passed: login, create SKU, zero threshold, request/approve/fulfill, ledger, cost dashboard, dark/mobile view, logout/reload, employee restrictions.",
  );
} finally {
  if (browser) await browser.close();
  if (server) await new Promise((resolve) => server.close(resolve));
  await mongoose.disconnect();
  if (database) await database.stop();
}
