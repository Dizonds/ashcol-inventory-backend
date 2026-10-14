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
  const compactWidth = (await page.locator(".stock-activity-card").boundingBox()).width;
  await page.getByRole("button", { name: "Expand chart", exact: true }).click();
  await page.waitForTimeout(300);
  const fullCard = page.locator(".stock-activity-card.is-expanded");
  await fullCard.scrollIntoViewIfNeeded();
  const fullGeometry = () => fullCard.evaluate(card => {
    const viewport = card.querySelector(".stock-chart-viewport");
    const svg = card.querySelector(".stock-svg-element");
    const footer = card.querySelector(".stock-chart-toolbar");
    return {
      cardHeight: card.getBoundingClientRect().height,
      scrollHeight: card.scrollHeight,
      clientHeight: card.clientHeight,
      plotHeight: viewport.getBoundingClientRect().height,
      svgHeight: svg.getBoundingClientRect().height,
      footerBottom: footer.getBoundingClientRect().bottom,
      cardBottom: card.getBoundingClientRect().bottom,
      cardWidth: card.getBoundingClientRect().width,
      gridWidth: card.parentElement.getBoundingClientRect().width,
      position: getComputedStyle(card).position,
      attentionTop: card.parentElement.querySelector(".dashboard-attention-card").getBoundingClientRect().top,
      recentTop: document.querySelector(".recent-activity-card").getBoundingClientRect().top,
    };
  });
  const desktopGeometry = await fullGeometry();
  assert.ok(desktopGeometry.plotHeight > 600, "Expanded view should provide a taller plot");
  assert.ok(desktopGeometry.cardWidth > compactWidth + 50, "Expanded chart should become wider");
  assert.ok(Math.abs(desktopGeometry.cardWidth - desktopGeometry.gridWidth) <= 1, "Expanded chart should span the dashboard grid");
  assert.equal(desktopGeometry.position, "relative", "The chart must remain in the page layout");
  assert.ok(desktopGeometry.attentionTop >= desktopGeometry.cardBottom, "Needs Attention should move below the chart");
  assert.ok(desktopGeometry.recentTop >= desktopGeometry.cardBottom, "Recent Activity should move below the expanded chart");
  assert.equal(await page.evaluate(() => document.body.style.overflow), "", "Expanding should not lock page scrolling");
  const fullCurve = await fullCard.locator(".stock-in-curve").getAttribute("d");
  const fullPlotBox = await fullCard.locator(".stock-chart-viewport").boundingBox();
  await page.mouse.move(fullPlotBox.x + fullPlotBox.width / 2, fullPlotBox.y + fullPlotBox.height / 2);
  await page.mouse.wheel(0, 100);
  await page.waitForTimeout(800);
  const zoomedCurve = await fullCard.locator(".stock-in-curve").getAttribute("d");
  assert.notEqual(zoomedCurve, fullCurve, "Scroll should zoom the expanded chart");
  await page.mouse.down();
  await page.mouse.move(fullPlotBox.x + fullPlotBox.width / 2 + 100, fullPlotBox.y + fullPlotBox.height / 2 + 80, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  assert.notEqual(await fullCard.locator(".stock-in-curve").getAttribute("d"), zoomedCurve, "Dragging should pan the expanded chart");
  const dragAxis = async (x, y, dx, dy) => {
    const before = await fullCard.locator(".stock-in-curve").getAttribute("d");
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dx, y + dy, { steps: 5 });
    await page.mouse.up();
    assert.notEqual(await fullCard.locator(".stock-in-curve").getAttribute("d"), before, "Axis dragging should stretch the chart");
  };
  await dragAxis(fullPlotBox.x + fullPlotBox.width / 2, fullPlotBox.y + fullPlotBox.height - 15, -60, 0);
  await dragAxis(fullPlotBox.x + 20, fullPlotBox.y + 120, 0, -40);
  await fullCard.getByRole("button", { name: "Reset", exact: true }).click();
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport);
    await page.waitForTimeout(200);
    const geometry = await fullGeometry();
    assert.ok(geometry.scrollHeight <= geometry.clientHeight + 1, `No expanded overflow at ${viewport.width}x${viewport.height}`);
    assert.ok(Math.abs(geometry.svgHeight - geometry.plotHeight) <= 1, "SVG should fill its viewport vertically");
    assert.ok(geometry.footerBottom <= geometry.cardBottom, "Footer should remain inside the full view");
    assert.ok(geometry.plotHeight > 100, "The plot should remain visible on smaller screens");
    assert.ok(geometry.attentionTop >= geometry.cardBottom, "Neighboring cards must not overlap the expanded chart");
  }
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.waitForTimeout(200);
  await inboundPoint().click();
  await page.getByRole("dialog").waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  assert.equal(await page.locator(".stock-activity-card.is-expanded").count(), 1, "Closing the popup should keep the chart expanded");
  const minimize = page.getByRole("button", { name: "Minimize chart", exact: true });
  assert.equal(await minimize.innerText(), "Minimize", "Minimize should have a visible label");
  await minimize.click();
  assert.equal(await page.locator(".stock-activity-card.is-expanded").count(), 0, "Minimize should return to the dashboard chart");
  const minimizedBox = await page.locator(".stock-activity-card").boundingBox();
  const attentionBox = await page.locator(".dashboard-attention-card").boundingBox();
  assert.ok(Math.abs(minimizedBox.width - compactWidth) <= 1, "Minimize should restore the compact width");
  assert.ok(attentionBox.x >= minimizedBox.x + minimizedBox.width, "Minimize should restore the neighboring card beside the chart");
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
  console.log("Chart browser checks passed: dot popup details across multiple SKUs and movement directions, keyboard access, drag without popup, expanded layout and popup closing, 7D default, and chart view restoration.");
} finally {
  if (browser) await browser.close();
  if (server) await new Promise(resolve => server.close(resolve));
  await mongoose.disconnect();
  if (database) await database.stop();
}
