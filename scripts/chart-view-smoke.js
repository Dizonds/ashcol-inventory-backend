// Verify chart view restoration against an isolated test database, without .env.
import assert from "node:assert/strict";
import path from "node:path";
import express from "express";
import mongoose from "mongoose";
import { chromium } from "playwright-core";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import app from "../src/app.js";
import { initializeDatabase } from "../src/setup.js";
import { User, Product, Movement } from "../src/models.js";
import { hashPassword } from "../src/auth.js";

let database, server, browser;
try {
  database = await MongoMemoryReplSet.create({ replSet: { count: 1 }, binary: { version: "7.0.14" } });
  await mongoose.connect(database.getUri(), { dbName: "chart_view_smoke" });
  await initializeDatabase();
  await User.create({ email: "chart@example.test", fullName: "Chart Reviewer", role: "ADMIN", branchId: "LOCAL-WAREHOUSE", passwordHash: await hashPassword("Temporary-test-2026") });
  const product = await Product.create({ branchId: "LOCAL-WAREHOUSE", sku: "CHART-VIEW", name: "Chart demo unit", itemType: "AC Unit", category: "Split Type", brand: "Carrier", unitOfMeasure: "UNIT", unitCost: 100, listPrice: 150, quantity: 100, reorderLevel: 1 });
  const entries = [];
  for (let daysAgo = 0; daysAgo < 40; daysAgo++) {
    const date = new Date();
    date.setDate(date.getDate() - daysAgo);
    date.setHours(0, 0, 0, 0);
    for (const delta of [2 + daysAgo % 5, -(1 + daysAgo % 3)]) entries.push({ productId: product._id, branchId: "LOCAL-WAREHOUSE", sku: product.sku, itemName: product.name, movementType: delta > 0 ? "STOCK_IN" : "STOCK_OUT", quantityDelta: delta, createdAt: date });
  }
  const other = await Product.create({ branchId: "LOCAL-WAREHOUSE", sku: "CHART-OTHER", name: "Refrigerant cylinder", itemType: "Consumable", category: "Refrigerants", brand: "Carrier", unitOfMeasure: "CYL", unitCost: 200, listPrice: 300, quantity: 9, reorderLevel: 1 });
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  yesterday.setHours(0, 0, 0, 0);
  entries.push({ productId: other._id, branchId: "LOCAL-WAREHOUSE", sku: other.sku, itemName: other.name, unitOfMeasure: "CYL", movementType: "STOCK_IN", quantityDelta: 9, beforeQuantity: 0, afterQuantity: 9, referenceId: "DEMO-RESTOCK", workOrderId: "JOB-DEMO", performedByName: "Demo Manager", reason: "Supplier restock for testing", createdAt: yesterday });
  await Movement.insertMany(entries);
  const web = express();
  web.use((req, res, next) => req.path.startsWith("/api/") ? app(req, res, next) : next());
  web.use(express.static(path.resolve("../ashcolinventoryreactfinal/ashcolinventory/build")));
  server = await new Promise(resolve => { const listener = web.listen(0, "127.0.0.1", () => resolve(listener)); });
  browser = await chromium.launch({ executablePath: process.env.BROWSER_PATH || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/movements?*", async route => {
    await new Promise(resolve => setTimeout(resolve, 150));
    await route.continue();
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.locator('input[type="email"]').fill("chart@example.test");
  await page.locator('input[type="password"]').fill("Temporary-test-2026");
  await page.locator('button[type="submit"]').click();
  await page.getByRole("heading", { name: "Stock In & Stock Out Activity", exact: true }).waitFor();
  const waitForHistory = () => page.waitForFunction(() => {
    const value = document.querySelector(".chip-stock-in .metric-chip-val")?.textContent;
    return value && value !== "+0";
  });
  await waitForHistory();
  assert.equal(await page.getByRole("button", { name: "7D", exact: true }).getAttribute("aria-pressed"), "true", "7D should be the default");
  const dateLabel = yesterday.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
  const inboundPoint = () => page.getByRole("button", { name: `View Stock In details for ${dateLabel}`, exact: true });
  await inboundPoint().click();
  let dialog = page.getByRole("dialog");
  await dialog.waitFor();
  assert.equal(await dialog.locator(".ant-table-tbody .ant-table-row").count(), 3, "Both inbound and outbound records should be shown");
  assert.equal(await dialog.getByText("CHART-VIEW", { exact: true }).count(), 2);
  assert.equal(await dialog.getByText("CHART-OTHER", { exact: true }).count(), 1);
  for (const detail of ["DEMO-RESTOCK", "JOB-DEMO", "Demo Manager", "Supplier restock for testing", "0 → 9", "+9 CYL"]) assert.equal(await dialog.getByText(detail, { exact: true }).count(), 1, detail);
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  const outboundPoint = page.getByRole("button", { name: `View Stock Out details for ${dateLabel}`, exact: true });
  await outboundPoint.focus();
  await outboundPoint.press("Enter");
  dialog = page.getByRole("dialog");
  await dialog.waitFor();
  assert.equal(await dialog.locator(".ant-table-tbody .ant-table-row").count(), 3);
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await inboundPoint().scrollIntoViewIfNeeded();
  const pointBox = await inboundPoint().boundingBox();
  await page.mouse.move(pointBox.x + pointBox.width / 2, pointBox.y + pointBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(pointBox.x + pointBox.width / 2 + 35, pointBox.y + pointBox.height / 2, { steps: 5 });
  await page.mouse.up();
  assert.equal(await page.getByRole("dialog").count(), 0, "Dragging a dot must not open the popup");
  await page.getByRole("button", { name: "Reset", exact: true }).click();
  await page.getByRole("button", { name: "Fullscreen View", exact: true }).click();
  await page.waitForTimeout(300);
  await inboundPoint().click();
  await page.getByRole("dialog").waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  assert.equal(await page.locator(".stock-activity-card.is-fullscreen").count(), 1, "Closing the popup should keep fullscreen active");
  await page.getByRole("button", { name: "Exit Fullscreen", exact: true }).click();
  await page.getByRole("button", { name: "Auto scale", exact: true }).click();
  const chart = page.locator(".stock-chart-viewport");
  await chart.scrollIntoViewIfNeeded();
  const box = await chart.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + 120);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 90, box.y + 150, { steps: 8 });
  await page.mouse.up();
  await page.mouse.wheel(0, 100);
  await page.waitForTimeout(800);
  await page.mouse.move(box.x + 20, box.y + 100);
  await page.mouse.wheel(0, -90);
  await page.waitForTimeout(800);
  await page.locator(".stock-legend-item").filter({ hasText: "Stock Out" }).click();
  await page.waitForTimeout(350);
  const snapshot = () => page.locator(".stock-activity-card").evaluate(card => ({
    curve: card.querySelector(".stock-in-curve")?.getAttribute("d"),
    axes: [...card.querySelectorAll(".stock-axis-label")].map(label => label.textContent),
    details: card.querySelector(".stock-chart-details")?.textContent,
    stockOut: card.querySelectorAll(".stock-out-curve").length,
    preset: card.querySelector(".stock-range-pill .active")?.textContent,
    mode: card.querySelector(".stock-mode-toggle .active")?.textContent,
    svgWidth: card.querySelector("svg.stock-svg-element")?.getAttribute("width"),
    viewportWidth: card.querySelector(".stock-chart-viewport")?.getBoundingClientRect().width,
  }));
  await page.mouse.move(1300, 20);
  await page.waitForTimeout(350);
  const before = await snapshot();
  await page.getByRole("button", { name: "Stock Ledger", exact: true }).click();
  await page.getByRole("heading", { name: "Inventory Transaction History", exact: true }).waitFor();
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  await page.mouse.move(1300, 20);
  await waitForHistory();
  await page.waitForTimeout(300);
  const after = await snapshot();
  assert.deepEqual(after, before, "The chart must restore its pan, scales, preset, and legend after history reloads");
  await page.getByRole("button", { name: "14D", exact: true }).click();
  await page.getByRole("button", { name: "Bars", exact: true }).click();
  await page.waitForTimeout(350);
  const barsBefore = await snapshot();
  await page.getByRole("button", { name: "Stock Ledger", exact: true }).click();
  await page.getByRole("heading", { name: "Inventory Transaction History", exact: true }).waitFor();
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  await page.mouse.move(1300, 20);
  await waitForHistory();
  await page.waitForTimeout(300);
  assert.deepEqual(await snapshot(), barsBefore, "A later timeframe and Bars selection must also be restored");
  assert.deepEqual(errors, []);
  console.log("Chart browser checks passed: dot popup details across multiple SKUs and movement directions, keyboard access, drag without popup, fullscreen popup closing, 7D default, and chart view restoration.");
} finally {
  if (browser) await browser.close();
  if (server) await new Promise(resolve => server.close(resolve));
  await mongoose.disconnect();
  if (database) await database.stop();
}
