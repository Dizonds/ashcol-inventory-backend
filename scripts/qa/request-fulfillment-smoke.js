import { frontendBuild } from "./environment.js";
// Real browser workflow with an isolated database; never connects to the live inventory.
import assert from "node:assert/strict";
import path from "node:path";
import express from "express";
import mongoose from "mongoose";
import { chromium } from "playwright-core";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import app from "../../src/app.js";
import { initializeDatabase } from "../../src/database/setup.js";
import { hashPassword } from "../../src/security/auth.js";
import { User, ServiceVan, Product, PartRequest, Movement } from "../../src/database/models.js";

let database, server, browser;
try {
  database = await MongoMemoryReplSet.create({ replSet: { count: 1 }, binary: { version: "7.0.14" } });
  await mongoose.connect(database.getUri("request_browser"));
  await initializeDatabase();
  const password = "Request-test-2026";
  const passwordHash = await hashPassword(password);
  const [, technician] = await User.insertMany([
    ["manager", "Request Manager", "MANAGER"], ["technician", "Assigned Technician", "EMPLOYEE"], ["unassigned", "Unassigned Technician", "EMPLOYEE"],
  ].map(([name, fullName, role]) => ({ email: `${name}@request.test`, fullName, role, branchId: "LOCAL-WAREHOUSE", passwordHash })));
  await ServiceVan.create({ _id: "VAN-REQUEST", name: "Request Van", driverId: String(technician._id), driverName: technician.fullName });
  const source = await Product.create({ branchId: "LOCAL-WAREHOUSE", sku: "AC-TEST", name: "Test AC unit", itemType: "AC Unit",
    category: "Split Type", brand: "Carrier", unitOfMeasure: "UNIT", unitCost: 100, listPrice: 150, reorderLevel: 0, quantity: 5 });
  const web = express();
  web.use((req, res, next) => req.path.startsWith("/api/") ? app(req, res, next) : next());
  web.use(express.static(frontendBuild));
  web.get("*", (req, res) => res.sendFile(path.join(frontendBuild, "index.html")));
  server = await new Promise((resolve) => { const listener = web.listen(0, "127.0.0.1", () => resolve(listener)); });
  browser = await chromium.launch({ executablePath: process.env.BROWSER_PATH || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: true });
  const errors = [];
  async function login(name) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
    page.on("pageerror", (error) => errors.push(error.message));
    if (process.env.REQUEST_FRONTEND_URL) await page.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      const response = await route.fetch({ url: `http://127.0.0.1:${server.address().port}${url.pathname}${url.search}` });
      await route.fulfill({ response });
    });
    await page.goto(process.env.REQUEST_FRONTEND_URL || `http://127.0.0.1:${server.address().port}`);
    await page.locator('input[type="email"]').fill(`${name}@request.test`);
    await page.locator('input[type="password"]').fill(password);
    await page.getByRole("button", { name: "Sign In", exact: true }).click();
    await page.getByRole("button", { name: "Material Requests", exact: true }).click();
    return page;
  }
  const unassigned = await login("unassigned");
  await unassigned.getByText(/You need an assigned service vehicle/).waitFor();
  assert.equal(await unassigned.getByRole("button", { name: "New Request", exact: true }).isDisabled(), true);
  const tech = await login("technician");
  await tech.getByRole("button", { name: "New Request", exact: true }).click();
  const dialog = tech.getByRole("dialog");
  await dialog.getByText("Request Van", { exact: true }).waitFor();
  for (const [name, option] of [["Request item type", "AC Unit"], ["Request brand", "Carrier"], ["Request item", "Test AC unit"]]) {
    await dialog.getByRole("combobox", { name, exact: true }).click();
    await tech.locator(".ant-select-item-option").filter({ hasText: option }).click();
  }
  await dialog.getByRole("spinbutton").fill("2");
  await dialog.getByRole("button", { name: "Submit request", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  const request = await PartRequest.findOne({ requestedBy: String(technician._id) });
  assert.ok(request);
  assert.match(request.requestNumber, /^REQ\d{4,}$/);
  assert.equal(request.destinationVanId, "VAN-REQUEST");
  const manager = await login("manager");
  await manager.getByRole("button", { name: "Approve", exact: true }).click();
  await manager.getByRole("button", { name: "Fulfill", exact: true }).click();
  await manager.getByRole("button", { name: "OK", exact: true }).click();
  await manager.getByText("FULFILLED", { exact: true }).waitFor();
  assert.equal((await Product.findById(source._id)).quantity, 3);
  assert.equal((await Product.findOne({ branchId: "VAN-REQUEST", sku: source.sku })).quantity, 2);
  assert.equal(await Movement.countDocuments({ referenceId: String(request._id) }), 2);
  const receipt = await Movement.findOne({ referenceId: String(request._id), movementType: "TRANSFER_IN" });
  assert.match(receipt.vehicleReceiptNumber, /^VAN\d{4,}$/);
  await tech.bringToFront();
  await tech.getByText("FULFILLED", { exact: true }).waitFor();
  await tech.getByRole("button", { name: "Service Vehicles", exact: true }).click();
  await tech.getByTitle("View vehicle details").click();
  await tech.getByRole("row").filter({ hasText: "Test AC unit" }).waitFor();
  const row = tech.getByRole("row").filter({ hasText: "Test AC unit" });
  assert.match(await row.innerText(), /2/);
  assert.deepEqual(errors, []);
  console.log("PASS: unassigned technician blocked; request -> approval -> fulfillment credits the assigned van and appears in its inventory.");
} finally {
  await browser?.close();
  if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  await mongoose.disconnect();
  await database?.stop();
}
