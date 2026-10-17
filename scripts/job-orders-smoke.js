// Exercise the manager -> technician -> ledger workflow against an isolated database.
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import express from "express";
import mongoose from "mongoose";
import { chromium } from "playwright-core";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import app from "../src/app.js";
import { initializeDatabase } from "../src/setup.js";
import { hashPassword } from "../src/auth.js";
import { User, ServiceVan, Product, JobOrder, Movement } from "../src/models.js";

let database, server, browser, failurePage;
const screenshotDirectory = path.resolve("../screenshots/job-order-updates");
try {
  await fs.mkdir(screenshotDirectory, { recursive: true });
  database = await MongoMemoryReplSet.create({ replSet: { count: 1 }, binary: { version: "7.0.14" } });
  await mongoose.connect(database.getUri("job_orders_browser"));
  await initializeDatabase();
  const password = "Job-test-2026";
  const passwordHash = await hashPassword(password);
  const [, technician] = await User.insertMany([
    { email: "manager@job.test", fullName: "Job Manager", role: "MANAGER", branchId: "LOCAL-WAREHOUSE", passwordHash },
    { email: "technician@job.test", fullName: "Job Technician", role: "EMPLOYEE", branchId: "LOCAL-WAREHOUSE", passwordHash },
  ]);
  await ServiceVan.create({ _id: "VAN-JOB", name: "Service Van", vehicleType: "Cargo Van", driverId: String(technician._id), driverName: technician.fullName });
  const products = await Product.insertMany([
    { sku: "PIPE", name: "Copper pipe", itemType: "Material / Part", category: "Piping", unitOfMeasure: "METER", quantity: 10 },
    { sku: "INSULATION", name: "Pipe insulation", itemType: "Material / Part", category: "Insulation", unitOfMeasure: "ROLL", quantity: 5 },
  ].map((item) => ({ ...item, branchId: "VAN-JOB", brand: "Carrier", unitCost: 10, listPrice: 15, reorderLevel: 0 })));
  const web = express();
  web.use((req, res, next) => req.path.startsWith("/api/") ? app(req, res, next) : next());
  web.use(express.static(path.resolve("../ashcolinventoryreactfinal/ashcolinventory/build")));
  server = await new Promise((resolve) => { const listener = web.listen(0, "127.0.0.1", () => resolve(listener)); });
  browser = await chromium.launch({ executablePath: process.env.BROWSER_PATH || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: true });
  const errors = [];
  async function login(email) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
    page.on("pageerror", (error) => errors.push(error.message));
    if (process.env.JOB_FRONTEND_URL) {
      await page.route("**/api/**", async (route) => {
        const url = new URL(route.request().url());
        const response = await route.fetch({ url: `http://127.0.0.1:${server.address().port}${url.pathname}${url.search}` });
        await route.fulfill({ response });
      });
    }
    await page.goto(process.env.JOB_FRONTEND_URL || `http://127.0.0.1:${server.address().port}`);
    await page.locator('input[type="email"]').fill(email);
    await page.locator('input[type="password"]').fill(password);
    await page.getByRole("button", { name: "Sign In", exact: true }).click();
    await page.getByRole("button", { name: "Job Orders", exact: true }).waitFor();
    return page;
  }
  const manager = await login("manager@job.test");
  await manager.getByRole("button", { name: "Job Orders", exact: true }).click();
  await manager.getByRole("button", { name: "Create Job Order", exact: true }).click();
  const createDialog = manager.getByRole("dialog");
  await createDialog.getByRole("textbox", { name: "Job title", exact: true }).fill("Office AC installation");
  await createDialog.getByRole("textbox", { name: "Customer", exact: true }).fill("Test customer");
  await createDialog.getByRole("textbox", { name: "Service location", exact: true }).fill("Taguig office");
  await createDialog.getByRole("combobox", { name: "Job service vehicle" }).click();
  await manager.locator(".ant-select-item-option").filter({ hasText: "Service Van" }).click();
  assert.equal(await createDialog.getByRole("textbox", { name: "Assigned technician" }).inputValue(), technician.fullName);
  await createDialog.getByRole("button", { name: "Create Job Order", exact: true }).click();
  await createDialog.waitFor({ state: "hidden" });
  await manager.getByText("JOB - 0001", { exact: true }).waitFor();
  await manager.getByRole("button", { name: "Assign job", exact: true }).click();
  await manager.getByRole("button", { name: "OK", exact: true }).click();
  await manager.getByText("Current job", { exact: true }).waitFor();
  await manager.screenshot({ path: path.join(screenshotDirectory, "job-orders-icon-actions.png"), fullPage: true });
  const job = await JobOrder.findOne({ jobNumber: "JOB0001" });
  assert.ok(job);

  const tech = await login("technician@job.test");
  failurePage = tech;
  await tech.getByRole("button", { name: "Service Vehicles", exact: true }).click();
  await tech.getByTitle("View vehicle details").click();
  const usedIds = [];
  for (const item of products) {
    await tech.getByRole("row").filter({ hasText: item.name }).getByRole("button", { name: "Record Usage", exact: true }).click();
    const dialog = tech.getByRole("dialog");
    await dialog.getByRole("textbox", { name: "Usage ID", exact: true }).waitFor();
    await tech.waitForFunction(() => /^USE - \d+$/.test(document.querySelector('input[aria-label="Usage ID"]')?.value || ""));
    usedIds.push(await dialog.getByRole("textbox", { name: "Usage ID", exact: true }).inputValue());
    const currentJob = dialog.getByRole("textbox", { name: "Current Job Order", exact: true });
    assert.equal(await currentJob.inputValue(), "JOB - 0001 · Office AC installation");
    assert.equal(await currentJob.getAttribute("readonly"), "");
    assert.equal(await dialog.getByRole("combobox", { name: "Job Order", exact: true }).count(), 0);
    await dialog.getByRole("spinbutton").fill("2");
    await dialog.getByPlaceholder("Describe where the material was installed/used").fill("Used for office installation");
    await dialog.getByRole("button", { name: "Record Usage", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
  }
  assert.equal(new Set(usedIds).size, 2);
  assert.equal(await Movement.countDocuments({ jobId: job._id }), 2);
  for (const item of products) assert.equal((await Product.findById(item._id)).quantity, item.quantity - 2);
  await tech.getByRole("button", { name: "Stock Ledger", exact: true }).click();
  const jobHeader = tech.locator("th").filter({ hasText: /JOB\s+ORDER/ });
  await jobHeader.scrollIntoViewIfNeeded();
  await jobHeader.waitFor();
  await tech.getByRole("cell", { name: "JOB - 0001", exact: true }).first().waitFor();
  assert.equal(await tech.getByRole("cell", { name: "JOB - 0001", exact: true }).count(), 2);
  await tech.getByRole("button", { name: "Job Orders", exact: true }).click();
  assert.equal(await tech.getByRole("button", { name: "Create Job Order", exact: true }).count(), 0);
  await tech.getByRole("button", { name: "View details", exact: true }).click();
  for (const id of usedIds) await tech.getByRole("dialog").getByText(id, { exact: true }).waitFor();
  await tech.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
  await tech.getByRole("button", { name: "Complete", exact: true }).click();
  await tech.getByRole("button", { name: "OK", exact: true }).click();
  await tech.getByText("COMPLETED", { exact: true }).waitFor();
  assert.equal((await JobOrder.findById(job._id)).status, "COMPLETED");
  failurePage = manager;
  await manager.bringToFront();
  await manager.getByRole("button", { name: /Refresh/ }).first().click();
  await manager.getByText("COMPLETED", { exact: true }).waitFor();
  // Archiving moves closed work out of the list without deleting its usage.
  await manager.getByRole("button", { name: "Archive job", exact: true }).click();
  await manager.getByRole("button", { name: "OK", exact: true }).click();
  await manager.getByText("JOB - 0001", { exact: true }).waitFor({ state: "hidden" });
  await manager.getByRole("button", { name: "View archived jobs", exact: true }).click();
  await manager.getByText("JOB - 0001", { exact: true }).waitFor();
  await manager.screenshot({ path: path.join(screenshotDirectory, "archived-job-orders.png"), fullPage: true });
  await manager.getByRole("button", { name: "View details", exact: true }).click();
  for (const id of usedIds) await manager.getByRole("dialog").getByText(id, { exact: true }).waitFor();
  await manager.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
  await tech.getByRole("button", { name: "Refresh", exact: true }).click();
  await tech.getByText("JOB - 0001", { exact: true }).waitFor({ state: "hidden" });
  await tech.getByRole("button", { name: "View archived jobs", exact: true }).click();
  await tech.getByText("JOB - 0001", { exact: true }).waitFor();
  assert.equal(await tech.getByRole("button", { name: "Restore job", exact: true }).count(), 0);
  assert.equal(await tech.getByRole("button", { name: "Archive job", exact: true }).count(), 0);
  await manager.getByRole("button", { name: "Restore job", exact: true }).click();
  await manager.getByRole("button", { name: "OK", exact: true }).click();
  await manager.getByText("JOB - 0001", { exact: true }).waitFor({ state: "hidden" });
  await manager.getByRole("button", { name: "View active jobs", exact: true }).click();
  await manager.getByText("JOB - 0001", { exact: true }).waitFor();
  assert.equal((await JobOrder.findById(job._id)).status, "COMPLETED");
  assert.equal((await JobOrder.findById(job._id)).archived, false);
  await manager.screenshot({ path: path.join(screenshotDirectory, "job-orders-icons-and-archive.png"), fullPage: true });
  failurePage = tech;
  await tech.bringToFront();
  await tech.getByRole("button", { name: "Service Vehicles", exact: true }).click();
  await tech.getByTitle("View vehicle details").click();
  await tech.getByRole("row").filter({ hasText: "Copper pipe" }).getByRole("button", { name: "Record Usage", exact: true }).click();
  await tech.getByText("No current job assigned. Ask your admin or manager to assign a job from Job Orders.", { exact: true }).waitFor();
  const missingJobDialog = tech.getByRole("dialog");
  await missingJobDialog.getByRole("button", { name: "Record Usage", exact: true }).click();
  assert.equal(await missingJobDialog.getByRole("textbox", { name: "Current Job Order", exact: true }).getAttribute("aria-invalid"), "true");
  assert.deepEqual(errors, []);
  console.log("Job browser checks passed: creation, icon actions, dispatch and completion work; closed jobs archive and restore with material history intact; technicians can read their own archives and cannot restore them.");
} catch (error) {
  if (failurePage) {
    console.error((await failurePage.locator("body").innerText()).slice(0, 5000));
    await failurePage.screenshot({ path: path.join(process.env.TEMP || ".", "ashcol-job-browser.png"), fullPage: true });
  }
  throw error;
} finally {
  if (browser) await browser.close();
  if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  await mongoose.disconnect();
  if (database) await database.stop();
}
