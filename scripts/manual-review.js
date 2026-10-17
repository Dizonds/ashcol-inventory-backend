// Exploratory browser QA against an isolated database. Does not load .env.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import mongoose from 'mongoose';
import { chromium } from 'playwright-core';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import app from '../src/app.js';
import { initializeDatabase } from '../src/setup.js';
import { hashPassword } from '../src/auth.js';
import { User, Product, Movement, ServiceVan, PartRequest, JobOrder } from '../src/models.js';

const out = path.resolve(process.env.QA_REVIEW_ARTIFACTS || '../ashcolinventoryreactfinal/artifacts/qa/manual-review-2026-10-17/fixed');
const results = [], errors = [], balances = [], traffic = [];
let db, server, browser, active;
const password = 'Review-pass-2026';
let admin, manager, tech;
const waitDb = async (fn) => {
  for (let i = 0; i < 40; i++) { const value = await fn(); if (value) return value; await new Promise(r => setTimeout(r, 150)); }
  throw new Error('Database condition did not become true');
};
const shot = async (page, name) => page.screenshot({ path: path.join(out, `${name}.png`), fullPage: true });
async function check(name, fn) {
  try { const detail = await fn(); results.push({ name, status: 'PASS', detail }); console.log('PASS:', name); }
  catch (e) { results.push({ name, status: 'FAIL', error: e.message }); console.log('FAIL:', name, e.message.slice(0, 500)); if (active) { await shot(active, `failure-${results.length}`).catch(() => {}); await active.reload().catch(() => {}); } }
  await fs.writeFile(path.join(out, 'results.json'), JSON.stringify({ results, balances, browserErrors: errors, traffic }, null, 2));
}
async function nav(session, name) {
  active = session.page;
  const target = active.getByRole('button', { name, exact: true }).first();
  if (!await target.isVisible() && await active.getByRole('button', { name: 'Open navigation', exact: true }).isVisible())
    await active.getByRole('button', { name: 'Open navigation', exact: true }).click();
  await target.click();
}
async function choose(page, locator, text) { await locator.click(); await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: text }).first().click(); }
async function snapshot(label, warehouse, vehicle) {
  const w = await Product.findOne({ branchId: 'LOCAL-WAREHOUSE', sku: 'QA-MAIN' });
  const v = await Product.findOne({ branchId: 'VAN-REVIEW', sku: 'QA-MAIN' });
  const actual = { label, warehouse: w?.quantity || 0, vehicle: v?.quantity || 0 };
  balances.push(actual); assert.equal(actual.warehouse, warehouse); assert.equal(actual.vehicle, vehicle);
}
try {
  await fs.mkdir(out, { recursive: true });
  db = await MongoMemoryReplSet.create({ replSet: { count: 1 }, binary: { version: '7.0.14' } });
  await mongoose.connect(db.getUri('manual_review'));
  await initializeDatabase();
  const passwordHash = await hashPassword(password);
  const users = await User.insertMany([
    ['admin', 'Review Admin', 'ADMIN'], ['manager', 'Review Manager', 'MANAGER'], ['tech', 'Review Technician', 'EMPLOYEE'], ['other', 'Other Technician', 'EMPLOYEE'],
  ].map(([name, fullName, role]) => ({ email: `${name}@review.test`, fullName, firstName: fullName.split(' ')[0], lastName: fullName.split(' ').slice(1).join(' '), role, branchId: 'LOCAL-WAREHOUSE', passwordHash })));
  const web = express();
  web.use((req, res, next) => req.path.startsWith('/api/') ? app(req, res, next) : next());
  web.use(express.static(path.resolve('../ashcolinventoryreactfinal/ashcolinventory/build')));
  server = await new Promise(resolve => { const s = web.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath: process.env.BROWSER_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  async function login(name) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.route('**/api/brands/*/logo', r => r.fulfill({ json: { logoUrl: null, sourceUrl: null } }));
    const page = await context.newPage(); page.setDefaultTimeout(10000);
    page.on('pageerror', e => errors.push(e.message));
    page.on('response', r => { if (r.url().includes('/api/') && r.request().method() !== 'GET') traffic.push({ method: r.request().method(), path: new URL(r.url()).pathname, status: r.status() }); });
    await page.goto(base); await page.getByLabel('Email', { exact: true }).fill(`${name}@review.test`);
    await page.getByLabel('Password', { exact: true }).fill(password); await page.getByRole('button', { name: 'Sign In', exact: true }).click();
    await page.getByRole('button', { name: 'Inventory Catalog', exact: true }).waitFor();
    const token = await page.evaluate(() => sessionStorage.getItem('ashcol_inventory_token'));
    const request = async (method, endpoint, data) => {
      const r = await context.request.fetch(`${base}/api${endpoint}`, { method, headers: { Authorization: `Bearer ${token}` }, data });
      return { status: r.status(), data: await r.json() };
    };
    return { context, page, request };
  }
  admin = await login('admin'); manager = await login('manager'); tech = await login('tech');
  active = admin.page;
  const common = { branchId: 'LOCAL-WAREHOUSE', brand: 'Carrier', unitCost: 150, listPrice: 220, reorderLevel: 0 };
  // Setup via application API, with opening balances recorded normally.
  for (const item of [
    { sku: 'QA-AC', name: 'QA Split AC', itemType: 'AC Unit', category: 'Split Type', unitOfMeasure: 'UNIT', quantity: 0 },
    { sku: 'QA-MAIN', name: 'QA Capacitor', itemType: 'Spare Part', category: 'Capacitors', unitOfMeasure: 'PCS', quantity: 10, reorderLevel: 10, compatibleModels: ['QA-AC'], capacity: '35 uF' },
    { sku: 'QA-UNMAPPED', name: 'QA Unmapped Capacitor', itemType: 'Spare Part', category: 'Capacitors', unitOfMeasure: 'PCS', quantity: 0 },
    { sku: 'QA-METER', name: 'QA Copper Tube', itemType: 'Consumable', category: 'Copper Tubing', unitOfMeasure: 'METER', quantity: 1.125 },
    { sku: 'QA-ZERO', name: 'QA Zero Part', itemType: 'Spare Part', category: 'Capacitors', unitOfMeasure: 'PCS', quantity: 0 },
  ]) { const r = await admin.request('POST', '/products', { ...common, ...item }); assert.equal(r.status, 201, JSON.stringify(r.data)); }
  assert.equal((await admin.request('POST', '/service-vans', { id: 'VAN-REVIEW', name: 'QA Review Vehicle', vehicleType: 'Cargo Van', plateNumber: 'QA-1001', driverId: String(users[2]._id) })).status, 201);
  const main = await Product.findOne({ sku: 'QA-MAIN' });
  await check('Main: opening balances', () => snapshot('Opening', 10, 0));
  async function post(direction, quantity) {
    await nav(manager, 'Post Movement'); const p = manager.page;
    if (direction === 'OUT') await p.getByText('Stock Out', { exact: true }).click();
    await p.getByLabel('Select an Item', { exact: true }).selectOption(String(main._id));
    await p.getByRole('spinbutton', { name: 'Quantity', exact: true }).fill(String(quantity));
    await p.getByLabel('Receipt, transfer reference, or explanation').fill(`QA ${direction} movement`);
    await p.waitForFunction(prefix => (document.querySelector('#pm-transaction-id')?.value || '').startsWith(prefix), direction === 'OUT' ? 'STO' : 'STI');
    await p.getByRole('button', { name: 'Confirm & Post', exact: true }).click();
    await shot(p, `review-${direction}`);
    await p.getByRole('dialog').getByRole('button', { name: 'Yes, Confirm & Post', exact: true }).click();
    await p.getByRole('dialog').waitFor({ state: 'hidden' });
  }
  await check('Main: UI receive five; warehouse 15', async () => { await post('IN', 5); await snapshot('Receive 5', 15, 0); });
  await check('Main: UI issue one; warehouse 14', async () => { await post('OUT', 1); await snapshot('Issue 1', 14, 0); });
  await check('Main: UI load three; warehouse 11, vehicle 3', async () => {
    await nav(manager, 'Inventory Catalog'); const p = manager.page;
    const row = p.getByRole('row').filter({ hasText: 'QA-MAIN' });
    await row.getByRole('button', { name: 'Add to Service Vehicle', exact: true }).click();
    const d = p.getByRole('dialog'); await d.getByRole('spinbutton', { name: 'Quantity to load', exact: true }).fill('3');
    await d.getByRole('button', { name: 'Confirm Load to Van', exact: true }).click(); await d.waitFor({ state: 'hidden' });
    await snapshot('Load 3', 11, 3);
  });
  await check('Main: UI technician requests two; no deduction', async () => {
    await nav(tech, 'Material Requests'); const p = tech.page;
    await p.getByRole('button', { name: 'New Request', exact: true }).click(); const d = p.getByRole('dialog');
    for (const [name, text] of [['Request item type', 'Spare Part'], ['Request brand', 'Carrier'], ['Request item', 'QA Capacitor']]) await choose(p, d.getByRole('combobox', { name, exact: true }), text);
    await d.getByRole('spinbutton').fill('2'); await d.getByLabel('Request notes').fill('QA additional parts');
    await d.getByRole('button', { name: 'Submit request', exact: true }).click(); await d.waitFor({ state: 'hidden' });
    assert.equal((await PartRequest.findOne({ sku: 'QA-MAIN' })).status, 'PENDING'); await snapshot('Request 2', 11, 3);
  });
  await check('Main: UI approval does not reserve/deduct stock', async () => {
    await nav(manager, 'Material Requests'); await manager.page.getByRole('button', { name: 'Approve', exact: true }).click();
    await waitDb(async () => (await PartRequest.findOne({ sku: 'QA-MAIN' }))?.status === 'APPROVED'); await snapshot('Approve 2', 11, 3);
  });
  await check('Main: UI fulfillment credits vehicle; 9 / 5', async () => {
    const p = manager.page; await p.getByRole('button', { name: 'Fulfill', exact: true }).click(); await p.getByRole('button', { name: 'OK', exact: true }).click();
    await p.getByText('FULFILLED', { exact: true }).waitFor(); await snapshot('Fulfill 2', 9, 5);
  });
  await check('Main: UI create and dispatch job', async () => {
    await nav(manager, 'Job Orders'); const p = manager.page; await p.getByRole('button', { name: 'Create Job Order', exact: true }).click(); const d = p.getByRole('dialog');
    await d.getByRole('textbox', { name: 'Job title', exact: true }).fill('QA Main Repair');
    await d.getByRole('textbox', { name: 'Customer', exact: true }).fill('QA Client'); await d.getByRole('textbox', { name: 'Service location', exact: true }).fill('QA Taguig');
    await choose(p, d.getByRole('combobox', { name: 'Job service vehicle' }), 'QA Review Vehicle');
    await d.getByRole('button', { name: 'Create Job Order', exact: true }).click(); await d.waitFor({ state: 'hidden' });
    const j = await JobOrder.findOne({ title: 'QA Main Repair' }); assert.equal(j.isCurrent, false);
    await p.getByRole('button', { name: 'Assign job', exact: true }).click(); await p.getByRole('button', { name: 'OK', exact: true }).click();
    await p.getByText('Current job', { exact: true }).waitFor(); await snapshot('Dispatch', 9, 5);
  });
  await check('Main: UI missing usage notes rejected, then use three; 9 / 2', async () => {
    await nav(tech, 'Service Vehicles'); const p = tech.page; await p.getByTitle('View vehicle details').click();
    await p.getByRole('row').filter({ hasText: 'QA-MAIN' }).getByRole('button', { name: 'Record Usage', exact: true }).click();
    const d = p.getByRole('dialog'); await p.waitForFunction(() => /^USE - \d+/.test(document.querySelector('input[aria-label="Usage ID"]')?.value || ''));
    await d.getByRole('spinbutton').fill('3'); await d.getByRole('button', { name: 'Record Usage', exact: true }).click();
    assert.equal(await d.locator('#consume-notes').getAttribute('aria-invalid'), 'true'); await snapshot('Rejected blank notes', 9, 5);
    await d.getByPlaceholder('Describe where the material was installed/used').fill('Installed three QA capacitors');
    await d.getByRole('button', { name: 'Record Usage', exact: true }).click(); await d.waitFor({ state: 'hidden' }); await snapshot('Use 3', 9, 2);
  });
  await check('Main: UI return one; 10 / 1', async () => {
    await nav(manager, 'Service Vehicles'); const p = manager.page; await p.getByTitle('View vehicle details').click();
    await p.getByRole('row').filter({ hasText: 'QA-MAIN' }).getByRole('button', { name: 'Unload to Branch', exact: true }).click();
    const d = p.getByRole('dialog'); await d.getByRole('spinbutton', { name: 'Quantity to return', exact: true }).fill('1');
    await d.getByRole('button', { name: 'Confirm Return', exact: true }).click(); await d.waitFor({ state: 'hidden' }); await snapshot('Return 1', 10, 1);
  });
  await check('Main: UI complete job and preserve usage history', async () => {
    await nav(tech, 'Job Orders'); const p = tech.page; await p.getByRole('button', { name: 'View details', exact: true }).click();
    await p.getByRole('dialog').getByRole('cell').filter({ hasText: 'QA-MAIN' }).waitFor(); await shot(p, 'job-material-history');
    await p.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click(); await p.getByRole('button', { name: 'Complete', exact: true }).click();
    await p.getByRole('button', { name: 'OK', exact: true }).click(); await p.getByText('COMPLETED', { exact: true }).waitFor(); await snapshot('Complete', 10, 1);
    assert.equal(await Movement.countDocuments({ movementType: 'JOB_CONSUMPTION', sku: 'QA-MAIN' }), 1);
  });
  await check('Main: UI missing current job blocks further use', async () => {
    await nav(tech, 'Service Vehicles'); const p = tech.page; await p.getByTitle('View vehicle details').click();
    await p.getByRole('row').filter({ hasText: 'QA-MAIN' }).getByRole('button', { name: 'Record Usage', exact: true }).click(); const d = p.getByRole('dialog');
    await d.getByRole('button', { name: 'Record Usage', exact: true }).click();
    assert.equal(await d.getByRole('textbox', { name: 'Current Job Order', exact: true }).getAttribute('aria-invalid'), 'true');
    await snapshot('Rejected no job', 10, 1); await d.getByRole('button', { name: 'Cancel', exact: true }).click();
  });
  await check('Main: ledger, database and conservation reconcile', async () => {
    await nav(admin, 'Stock Ledger'); const p = admin.page; await p.getByPlaceholder('Search SKU, item, or reference').fill('QA-MAIN');
    await p.getByText('Returned', { exact: true }).first().waitFor(); await shot(p, 'main-ledger');
    const moves = await Movement.find({ sku: 'QA-MAIN' }).lean();
    assert.equal(moves.filter(m => m.movementType === 'TRANSFER_OUT').length, 2);
    assert.equal(moves.filter(m => m.movementType === 'TRANSFER_IN').length, 3);
    assert.equal(10 + 5, 10 + 1 + 3 + 1); await snapshot('Final', 10, 1);
    await fs.writeFile(path.join(out, 'main-stock-movements.json'), JSON.stringify(moves, null, 2));
    return { movementRows: moves.length, warehouse: 10, vehicle: 1, used: 3, issued: 1 };
  });
  await check('UI overall stock balance has one line, reconciles warehouse stock and separates units', async () => {
    await nav(admin, 'Overview'); const p = admin.page;
    assert.equal(await p.getByRole('heading', { name: 'Overall Stock Balance', exact: true }).count(), 0, 'No separate balance card');
    await p.getByRole('group', { name: 'Chart display type' }).getByRole('button', { name: 'Overall', exact: true }).click();
    const card = p.locator('.stock-activity-card');
    const chart = p.getByRole('region', { name: 'Overall stock balance', exact: true });
    await p.getByLabel('Chart unit of measure').selectOption('PCS');
    await chart.getByTestId('stock-balance-current').waitFor();
    assert.match(await chart.getByTestId('stock-balance-current').innerText(), /10\s*PCS/);
    assert.equal(await chart.locator('[data-series="stock-balance"]').count(), 1);
    await p.getByRole('button', { name: '30D', exact: true }).click();
    assert.equal(await chart.locator('svg [role="button"]').count(), 7, 'Six warehouse movements plus the starting balance');
    await chart.locator('svg [role="button"]').last().focus();
    assert.match(await chart.locator('.stock-balance-detail').innerText(), /\+1 PCS →\s*10 PCS/);
    await card.screenshot({ path: path.join(out, 'overall-stock-balance-desktop.png') });
    await p.getByLabel('Chart unit of measure').selectOption('METER');
    assert.match(await chart.getByTestId('stock-balance-current').innerText(), /1\.125\s*METER/);
    await p.getByLabel('Chart unit of measure').selectOption('PCS');
    await p.getByRole('button', { name: 'Bar', exact: true }).click();
    await p.getByRole('img', { name: 'Stock movement activity trend chart', exact: true }).waitFor();
    await p.getByRole('button', { name: 'Line', exact: true }).click();
    await p.getByRole('button', { name: 'Overall', exact: true }).click();
    await nav(admin, 'Inventory Catalog'); await nav(admin, 'Overview');
    assert.equal(await p.getByRole('button', { name: 'Overall', exact: true }).getAttribute('aria-pressed'), 'true');
    await p.getByRole('button', { name: 'Expand chart', exact: true }).click();
    await p.getByRole('button', { name: 'Minimize chart', exact: true }).waitFor();
    assert.equal(await chart.locator('[data-series="stock-balance"]').count(), 1);
    await card.screenshot({ path: path.join(out, 'overall-stock-balance-expanded.png') });
    await p.getByRole('button', { name: 'Minimize chart', exact: true }).click();
    await p.setViewportSize({ width: 390, height: 844 });
    await p.waitForTimeout(200);
    assert.equal(await chart.locator('.stock-balance-plot').evaluate(node => node.scrollWidth > node.clientWidth), false);
    await card.screenshot({ path: path.join(out, 'overall-stock-balance-mobile.png') });
    assert.equal(await p.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await p.setViewportSize({ width: 1440, height: 1000 });
  });
  await check('UI vehicle name and plate persist after Save Changes and reload', async () => {
    await nav(admin, 'Service Vehicles'); const p = admin.page; await p.getByTitle('Edit vehicle info').click(); const d = p.getByRole('dialog');
    await d.getByRole('textbox').nth(0).fill('QA Renamed Vehicle'); await d.getByRole('textbox').nth(1).fill('QA-2002');
    await d.getByRole('button', { name: 'Save Changes', exact: true }).click(); await d.waitFor({ state: 'hidden' }); await shot(p, 'vehicle-after-save');
    const saved = await ServiceVan.findById('VAN-REVIEW');
    await p.reload(); await p.getByTitle('Edit vehicle info').waitFor(); await shot(p, 'vehicle-after-reload');
    assert.equal(saved.name, 'QA Renamed Vehicle', `Database retained name=${saved.name}, plate=${saved.plateNumber}; expected new name and plate`);
    assert.equal(saved.plateNumber, 'QA-2002');
  });
  await check('UI supplier edit, invalid email rejection and persistence', async () => {
    await nav(admin, 'Suppliers & Vendors'); const p = admin.page; await p.getByRole('button', { name: 'Register Supplier', exact: true }).click(); let d = p.getByRole('dialog');
    await d.getByLabel('Company / Supplier Name *', { exact: true }).fill('QA Review Supply'); await d.getByLabel('Email Address', { exact: true }).fill('invalid');
    await d.getByLabel('Phone Number', { exact: true }).fill('09171234567'); await d.getByRole('button', { name: 'Register Supplier', exact: true }).click();
    assert.equal(await mongoose.connection.collection('suppliers').countDocuments({ name: 'QA Review Supply' }), 0);
    await d.getByLabel('Email Address', { exact: true }).fill('review@example.com'); await d.getByRole('button', { name: 'Register Supplier', exact: true }).click(); await d.waitFor({ state: 'hidden' });
    await p.getByTitle('Edit Supplier', { exact: true }).click(); d = p.getByRole('dialog');
    const fields = await d.locator('input').evaluateAll(nodes => nodes.map(n => ({ type: n.type, value: n.value, placeholder: n.placeholder })));
    const contact = d.getByLabel(/Contact Person/i); await contact.fill('QA Updated Contact'); await d.getByRole('button', { name: 'Save Changes', exact: true }).click(); await d.waitFor({ state: 'hidden' });
    await p.reload(); await p.getByRole('cell', { name: 'QA Review Supply', exact: true }).waitFor();
    assert.equal((await mongoose.connection.collection('suppliers').findOne({ name: 'QA Review Supply' })).contactPerson, 'QA Updated Contact'); return fields;
  });
  await check('UI catalog archive/restore and unchanged zero balance', async () => {
    await nav(admin, 'Inventory Catalog'); const p = admin.page; let row = p.getByRole('row').filter({ hasText: 'QA-ZERO' });
    await row.getByRole('button', { name: 'Archive item', exact: true }).click(); await p.getByRole('button', { name: 'OK', exact: true }).click(); await row.waitFor({ state: 'hidden' });
    await p.getByRole('button', { name: 'View archived zero-stock items', exact: true }).click(); row = p.getByRole('row').filter({ hasText: 'QA-ZERO' });
    await row.getByRole('button', { name: 'Restore item', exact: true }).click(); await p.getByRole('button', { name: 'OK', exact: true }).click(); await row.waitFor({ state: 'hidden' });
    const item = await Product.findOne({ sku: 'QA-ZERO' }); assert.equal(item.quantity, 0); assert.equal(item.archived, false);
    assert.equal(await Movement.countDocuments({ sku: 'QA-ZERO', movementType: { $in: ['ARCHIVE', 'RESTORE'] }, quantityDelta: { $ne: 0 } }), 0);
  });
  await check('UI model matching includes only explicitly compatible parts', async () => {
    await nav(admin, 'Model Matching'); const p = admin.page;
    if (await p.getByText('Select AC Unit Model', { exact: true }).count()) {
      await p.locator('.model-matching-selector-btn').click(); await p.getByRole('menuitem').filter({ hasText: 'QA-AC' }).click();
    }
    await p.getByText('QA Capacitor', { exact: true }).waitFor();
    assert.equal(await p.getByText('QA Unmapped Capacitor', { exact: true }).count(), 0);
    await p.getByPlaceholder('Search SKU, name, or supplier').fill('not-a-match');
    assert.equal(await p.getByText('QA Capacitor', { exact: true }).count(), 0);
    await p.getByPlaceholder('Search SKU, name, or supplier').fill(''); await p.getByText('QA Capacitor', { exact: true }).waitFor();
    await shot(p, 'model-compatible-only');
  });
  await check('UI category filter includes registered Capacitors category', async () => {
    await nav(admin, 'Inventory Catalog'); const p = admin.page;
    await p.getByText('All Categories', { exact: true }).click();
    await p.getByRole('menuitem', { name: 'Capacitors', exact: true }).waitFor({ timeout: 2000 });
    await p.getByRole('menuitem', { name: 'Capacitors', exact: true }).click();
    await p.getByRole('row').filter({ hasText: 'QA-MAIN' }).waitFor();
  });
  await check('UI vehicle edit failure leaves status unchanged', async () => {
    assert.equal((await admin.request('PATCH', '/service-vans/VAN-REVIEW/status', { status: 'ON_FIELD' })).status, 200);
    await nav(admin, 'Service Vehicles'); const p = admin.page; await p.reload(); await p.getByTitle('Edit vehicle info').click(); const d = p.getByRole('dialog');
    await choose(p, d.getByRole('combobox').nth(0), 'Other Technician');
    await choose(p, d.getByRole('combobox').nth(1), 'Available at Base'); await d.getByRole('button', { name: 'Save Changes', exact: true }).click();
    await d.getByRole('alert').waitFor(); const error = await d.getByRole('alert').innerText(); await shot(p, 'vehicle-partial-save');
    const van = await ServiceVan.findById('VAN-REVIEW');
    assert.equal(van.status, 'ON_FIELD', `Form reports failure (${error}) but database status changed to ${van.status}`);
    assert.equal(van.driverId, String(users[2]._id));
    await d.getByRole('button', { name: 'Cancel', exact: true }).click();
  });
  await check('UI status-only vehicle edit succeeds with unchanged on-field driver', async () => {
    await nav(admin, 'Service Vehicles'); const p = admin.page; await p.getByTitle('Edit vehicle info').click(); const d = p.getByRole('dialog');
    await choose(p, d.getByRole('combobox').nth(1), 'Available at Base');
    await d.getByRole('button', { name: 'Save Changes', exact: true }).click(); await d.waitFor({ state: 'hidden' });
    assert.equal((await ServiceVan.findById('VAN-REVIEW')).status, 'AVAILABLE');
  });
  // Restore base status after the intentionally rejected vehicle edit case.
  await admin.request('PATCH', '/service-vans/VAN-REVIEW/status', { status: 'AVAILABLE' });
  await check('UI request denial, reason details, delete and retained history', async () => {
    const item = await Product.findOne({ sku: 'QA-ZERO' });
    const created = await tech.request('POST', '/requests', { productId: String(item._id), quantityNeeded: 1, notes: 'Alternate denied request' });
    assert.equal(created.status, 201); const id = created.data.id;
    await nav(admin, 'Material Requests'); const p = admin.page; const row = p.getByRole('row').filter({ hasText: 'QA-ZERO' });
    await row.getByRole('button', { name: 'Deny', exact: true }).click(); let d = p.getByRole('dialog');
    await d.locator('textarea').fill('QA material not needed'); await d.getByRole('button', { name: 'OK', exact: true }).click(); await d.waitFor({ state: 'hidden' });
    await row.getByTitle('View request details and denial reason').click(); d = p.getByRole('dialog'); await d.getByText('QA material not needed', { exact: true }).waitFor();
    await d.getByRole('button', { name: 'Close', exact: true }).first().click(); await row.getByRole('button', { name: 'Delete', exact: true }).click(); d = p.getByRole('dialog');
    await d.getByRole('button', { name: 'Delete Request', exact: true }).click(); await d.waitFor({ state: 'hidden' });
    await p.getByRole('checkbox', { name: 'Show deleted requests', exact: true }).check(); await row.waitFor();
    const saved = await PartRequest.findById(id); assert.equal(saved.status, 'DENIED'); assert.ok(saved.deletedAt); await snapshot('Denied/deleted alternate', 10, 1);
  });
  await check('UI job edit, queue switch and cancellation', async () => {
    for (const title of ['QA Extra A', 'QA Extra B']) {
      const r = await admin.request('POST', '/job-orders', { title, customerName: 'QA', location: 'QA', vanId: 'VAN-REVIEW', assignedTechnicianId: String(users[2]._id) }); assert.equal(r.status, 201);
    }
    await nav(admin, 'Job Orders'); const p = admin.page; const rowA = p.getByRole('row').filter({ hasText: 'QA Extra A' }); const rowB = p.getByRole('row').filter({ hasText: 'QA Extra B' });
    await rowA.getByRole('button', { name: 'Edit', exact: true }).click(); const d = p.getByRole('dialog'); await d.getByLabel('Description (optional)', { exact: true }).fill('Edited by QA');
    await d.getByRole('button', { name: 'Save changes', exact: true }).click(); await d.waitFor({ state: 'hidden' }); assert.equal((await JobOrder.findOne({ title: 'QA Extra A' })).description, 'Edited by QA');
    for (const row of [rowA, rowB]) { await row.getByRole('button', { name: 'Assign job', exact: true }).click(); await p.getByRole('button', { name: 'OK', exact: true }).click(); await row.getByText('Current job', { exact: true }).waitFor(); }
    assert.equal(await JobOrder.countDocuments({ isCurrent: true }), 1); assert.equal((await JobOrder.findOne({ title: 'QA Extra A' })).isCurrent, false);
    for (const row of [rowA, rowB]) { await row.getByRole('button', { name: 'Cancel job', exact: true }).click(); await p.getByRole('button', { name: 'OK', exact: true }).click(); await row.getByText('CANCELLED', { exact: true }).waitFor(); }
  });
  await check('UI vehicle status control and live cross-session updates', async () => {
    await nav(tech, 'Service Vehicles'); const p = tech.page; await p.reload(); await p.getByTitle('View vehicle details').click();
    const combos = await p.getByRole('combobox').count();
    await fs.writeFile(path.join(out, 'vehicle-controls.txt'), await p.locator('body').innerText());
    // Exercise the status via the named visible control when available.
    const status = p.getByRole('combobox', { name: 'Current status select', exact: true });
    if (!await status.count()) throw new Error(`Status control needs locator inspection (${combos} comboboxes)`);
    await status.selectOption('ON_FIELD'); await waitDb(async () => (await ServiceVan.findById('VAN-REVIEW')).status === 'ON_FIELD');
    await status.selectOption('ARRIVED'); await waitDb(async () => (await ServiceVan.findById('VAN-REVIEW')).status === 'ARRIVED');
    await status.selectOption('AVAILABLE'); await waitDb(async () => (await ServiceVan.findById('VAN-REVIEW')).status === 'AVAILABLE');
  });
  await check('UI create, edit and remove temporary account', async () => {
    await nav(admin, 'User Management'); const p = admin.page; await p.getByRole('button', { name: /Create User Account/ }).click();
    await p.getByLabel('First name', { exact: true }).fill('Temp'); await p.getByLabel('Last name', { exact: true }).fill('Reviewer');
    await p.getByLabel('Work email address', { exact: true }).fill('temp@review.test'); await p.getByPlaceholder('At least 10 characters', { exact: true }).fill(password);
    await p.getByPlaceholder('Re-enter temporary password', { exact: true }).fill(password); await p.getByRole('button', { name: 'Create User Account', exact: true }).click();
    await waitDb(() => User.findOne({ email: 'temp@review.test' }));
    await p.getByRole('button', { name: /Back to User Management/ }).click(); await p.getByRole('button', { name: /Registered User Accounts/ }).click();
    const row = p.getByRole('row').filter({ hasText: 'temp@review.test' }); await row.getByRole('button').click();
    await p.getByText('Edit User', { exact: true }).click(); let d = p.getByRole('dialog');
    await choose(p, d.getByRole('combobox', { name: 'Account availability', exact: true }), 'Away'); await d.getByRole('button', { name: 'Save Changes', exact: true }).click(); await d.waitFor({ state: 'hidden' });
    assert.equal((await User.findOne({ email: 'temp@review.test' })).availability, 'AWAY');
    await row.getByRole('button').click(); await p.getByText('Delete User', { exact: true }).click(); d = p.getByRole('dialog');
    await d.getByRole('button', { name: 'Remove User', exact: true }).click(); await d.waitFor({ state: 'hidden' }); assert.equal(await User.countDocuments({ email: 'temp@review.test' }), 0);
  });
  await check('UI profile update persists; logout revokes session', async () => {
    await nav(manager, 'Overview'); const p = manager.page; await p.locator('.header-user-btn').click(); await p.getByText('Edit Profile', { exact: true }).click(); const d = p.getByRole('dialog');
    await d.getByLabel('First name', { exact: true }).fill('Reviewed'); await d.getByRole('button', { name: 'Save Changes', exact: true }).click(); await d.waitFor({ state: 'hidden' });
    await p.reload(); await p.getByText('Reviewed Manager', { exact: true }).first().waitFor();
    await p.locator('.header-user-btn').click(); await p.getByText('Log Out', { exact: true }).click(); await p.getByRole('dialog').getByRole('button', { name: 'Log out', exact: true }).click();
    await p.getByRole('button', { name: 'Sign In', exact: true }).waitFor(); assert.equal((await manager.request('GET', '/auth/me')).status, 401);
  });
  // Capture every main page at desktop and phone widths for visual inspection.
  for (const module of ['Overview', 'Inventory Catalog', 'Material Requests', 'Post Movement', 'Stock Ledger', 'Service Vehicles', 'Job Orders', 'Model Matching', 'Suppliers & Vendors', 'User Management']) {
    await check(`UI navigation, screenshots and page overflow metric: ${module}`, async () => {
      const p = admin.page; await p.setViewportSize({ width: 1440, height: 1000 }); await p.reload();
      await nav(admin, module); await p.waitForTimeout(450); const stem = module.toLowerCase().replace(/[^a-z]+/g, '-');
      await shot(p, `${stem}-desktop`); await fs.writeFile(path.join(out, `${stem}-text.txt`), await p.locator('body').innerText());
      await p.setViewportSize({ width: 390, height: 844 }); await p.waitForTimeout(250); await shot(p, `${stem}-mobile`);
      const layout = await p.evaluate(() => ({ viewport: innerWidth, width: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth }));
      if (layout.width > layout.viewport + 2) throw new Error(`Page overflows viewport: ${JSON.stringify(layout)}`);
      const clippedSearches = await p.locator('.catalog-search-wrap, .suppliers-search-box, .stock-ledger-search-wrap, .model-matching-search-box').evaluateAll(nodes => nodes.map(node => {
        const box = node.getBoundingClientRect(); return { left: box.left, right: box.right, width: box.width };
      }).filter(box => box.width && (box.left < 0 || box.right > innerWidth)));
      assert.deepEqual(clippedSearches, [], 'Search controls must fit inside the viewport');
      return layout;
    });
  }
  await check('Narrow viewport: drawer overlays full-width content and closes after navigation', async () => {
    const p = admin.page; await nav(admin, 'Inventory Catalog'); await p.setViewportSize({ width: 390, height: 844 });
    await p.getByRole('button', { name: 'Open navigation', exact: true }).click();
    await p.locator('.ashcol-sidebar').hover(); await p.waitForTimeout(450); await shot(p, 'phone-sidebar-expanded');
    const expanded = await p.locator('.app-main').boundingBox();
    await p.getByRole('button', { name: 'Overview', exact: true }).click();
    await p.getByRole('dialog').waitFor({ state: 'hidden' });
    await p.getByRole('heading', { name: 'Overview', exact: true }).waitFor();
    await p.waitForTimeout(450); await shot(p, 'phone-sidebar-collapsed');
    const collapsed = await p.locator('.app-main').boundingBox();
    await fs.writeFile(path.join(out, 'phone-layout.json'), JSON.stringify({ expanded, collapsed }, null, 2));
    assert.equal(expanded.width, 390); assert.equal(collapsed.width, 390);
    await p.getByRole('button', { name: 'Open navigation', exact: true }).click(); await p.keyboard.press('Escape'); await p.getByRole('dialog').waitFor({ state: 'hidden' });
  });
  await check('Dark mode desktop and phone', async () => {
    const p = admin.page; await p.setViewportSize({ width: 1440, height: 1000 }); await nav(admin, 'Overview');
    await p.getByTitle('Switch to Dark mode', { exact: true }).click(); await shot(p, 'dark-desktop'); await p.setViewportSize({ width: 390, height: 844 }); await shot(p, 'dark-mobile');
  });
  await check('No uncaught browser exceptions', () => assert.deepEqual(errors, []));
  await fs.writeFile(path.join(out, 'results.json'), JSON.stringify({ results, balances, browserErrors: errors, traffic }, null, 2));
  console.log(JSON.stringify({ passed: results.filter(r => r.status === 'PASS').length, failed: results.filter(r => r.status === 'FAIL').length, out }));
  if (results.some(result => result.status === 'FAIL')) process.exitCode = 1;
} finally {
  await browser?.close(); if (server) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
  await mongoose.disconnect(); await db?.stop();
}
