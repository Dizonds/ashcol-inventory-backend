import { frontendBuild } from "./environment.js";
// Uses a disposable database and independent admin, manager, and technician sessions.
// Never loads .env or changes the user's inventory database.
import assert from "node:assert/strict";
import path from "node:path";
import express from "express";
import mongoose from "mongoose";
import { chromium } from "playwright-core";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import app from "../../src/app.js";
import { initializeDatabase } from "../../src/database/setup.js";
import { User, ServiceVan } from "../../src/database/models.js";
import { hashPassword } from "../../src/security/auth.js";

let database, server, browser;
try {
  database = await MongoMemoryReplSet.create({ replSet: { count: 1 }, binary: { version: "7.0.14" } });
  await mongoose.connect(database.getUri(), { dbName: "live_updates_smoke" });
  await initializeDatabase();
  const password = "Live-test-2026";
  const passwordHash = await hashPassword(password);
  const [admin, tech, manager] = await User.insertMany([
    { email: "admin@live.test", fullName: "Live Admin", role: "ADMIN", branchId: "LOCAL-WAREHOUSE", passwordHash },
    { email: "tech@live.test", fullName: "Live Technician", role: "EMPLOYEE", branchId: "LOCAL-WAREHOUSE", passwordHash },
    { email: "manager@live.test", fullName: "Live Manager", role: "MANAGER", branchId: "LOCAL-WAREHOUSE", passwordHash },
  ]);
  const van = await ServiceVan.create({ _id: "VAN-LIVE", name: "Live Test Vehicle", vehicleType: "Cargo Van" });
  const web = express();
  web.use((req, res, next) => req.path.startsWith("/api/") ? app(req, res, next) : next());
  web.use(express.static(frontendBuild));
  web.get("*", (req, res) => res.sendFile(path.join(frontendBuild, "index.html")));
  server = await new Promise((resolve) => {
    const listener = web.listen(0, "127.0.0.1", () => resolve(listener));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath: process.env.BROWSER_PATH || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: true });
  const sessions = [];
  const errors = [];
  for (const user of [admin, tech, manager]) {
    const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: user.email, password }) });
    assert.equal(login.status, 200);
    const { token } = await login.json();
    const context = await browser.newContext();
    await context.addInitScript((value) => sessionStorage.setItem("ashcol_inventory_token", value), token);
    // Logo discovery is tested separately; don't call external providers in this test.
    await context.route("**/api/brands/*/logo", (route) => route.fulfill({ json: { logoUrl: null, sourceUrl: null } }));
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(base);
    await page.getByRole("button", { name: "Service Vehicles", exact: true }).click();
    await page.getByRole("heading", { name: "Service Vehicles Overview", exact: true }).waitFor();
    const mutate = async (method, endpoint, data) => {
      const response = await context.request.fetch(`${base}/api${endpoint}`, { method, headers: { Authorization: `Bearer ${token}` }, data });
      assert.ok(response.ok(), await response.text());
      return response.json();
    };
    sessions.push({ context, page, mutate });
  }
  const [adminSession, techSession, managerSession] = sessions;
  assert.equal(await techSession.page.getByText(van.name, { exact: true }).count(), 0);
  await adminSession.mutate("PATCH", `/service-vans/${van.id}/driver`, { driverId: String(tech._id) });
  await techSession.page.getByText(van.name, { exact: true }).first().waitFor({ timeout: 10000 });
  console.log("PASS: a technician sees an admin's vehicle assignment without refreshing.");
  await techSession.page.reload();
  await techSession.page.getByRole("heading", { name: "Service Vehicles Overview", exact: true }).waitFor();
  await techSession.page.getByText(van.name, { exact: true }).first().waitFor();
  console.log("PASS: refreshing keeps the technician on Service Vehicles.");

  assert.equal(await techSession.page.getByRole("button", { name: "Suppliers & Vendors", exact: true }).count(), 0);
  const brandSessions = [adminSession, managerSession];
  for (const { page } of brandSessions) {
    await page.getByRole("button", { name: "Suppliers & Vendors", exact: true }).click();
    await page.getByRole("button", { name: "Show Brands" }).click();
  }
  await adminSession.page.getByLabel("New brand name").fill("Keep my draft");
  await adminSession.mutate("POST", "/brands", { name: "Live Added Brand" });
  for (const { page } of brandSessions) {
    await page.getByText("Live Added Brand", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Hide Brands" }).count(), 1);
  }
  assert.equal(await adminSession.page.getByLabel("New brand name").inputValue(), "Keep my draft");
  console.log("PASS: brand updates reach both sessions without closing Brands or clearing the draft.");
  await managerSession.page.reload();
  await managerSession.page.getByRole("heading", { name: "Suppliers List", exact: true }).waitFor();
  console.log("PASS: refreshing also keeps the selected Suppliers & Vendors page.");

  await adminSession.page.getByRole("button", { name: "Inventory Catalog", exact: true }).click();
  await adminSession.page.getByRole("button", { name: "Register Item", exact: true }).click();
  await adminSession.page.getByLabel("Item name", { exact: true }).fill("Unsaved item draft");
  const nextSnapshot = adminSession.page.waitForResponse((response) => response.url().endsWith("/api/service-vans") && response.request().method() === "GET");
  await techSession.mutate("PATCH", `/service-vans/${van.id}/status`, { status: "ON_FIELD" });
  await nextSnapshot;
  assert.equal(await adminSession.page.getByLabel("Item name", { exact: true }).inputValue(), "Unsaved item draft");
  console.log("PASS: incoming changes preserve an open item-registration form.");
  await adminSession.page.getByRole("button", { name: "Close", exact: true }).click();

  await techSession.page.getByRole("button", { name: "Service Vehicles", exact: true }).click();
  await techSession.page.getByText(van.name, { exact: true }).first().waitFor();
  await adminSession.mutate("PATCH", `/service-vans/${van.id}/status`, { status: "AVAILABLE" });
  await adminSession.mutate("PATCH", `/service-vans/${van.id}/driver`, { driverId: "" });
  await techSession.page.getByText(van.name, { exact: true }).first().waitFor({ state: "detached", timeout: 10000 });
  console.log("PASS: an unassigned vehicle disappears from the technician's session automatically.");
  assert.deepEqual(errors, []);
} finally {
  if (browser) await browser.close();
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  await mongoose.disconnect();
  if (database) await database.stop();
}
