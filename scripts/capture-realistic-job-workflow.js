// Captures the real UI using an isolated temporary database. Does not load .env.
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
import { User, ServiceVan, Product, JobOrder, Counter, Movement, PartRequest, Supplier } from '../src/models.js';

const out = path.resolve('../screenshots/realistic-job-workflow');
const steps = [];
const errors = [];
const mainSku = 'COP-PAIR-1438';
const mainJob = 'JOB - 0149';
const mainTitle = '1.5 HP split-type AC installation';
const vanId = 'VAN-03';
let database, server, browser, active;
const ActualDate = Date;
let captureTime = ActualDate.parse('2026-10-18T08:10:00+08:00');
const pages = [];
async function at(time) {
  captureTime = ActualDate.parse(`2026-10-18T${time}:00+08:00`);
  for (const page of pages) await page.clock.setFixedTime(new ActualDate(captureTime));
}

async function shot(page, file, title, caption) {
  active = page;
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => Array.from(document.images).every(img => img.complete));
  for (const notice of await page.getByRole('button', { name: /^Dismiss notification:/ }).all()) {
    await notice.click();
    await notice.waitFor({ state: 'hidden' });
  }
  await page.mouse.move(1890, 1170);
  await page.screenshot({ path: path.join(out, file), fullPage: true, animations: 'disabled' });
  steps.push({ file, title, caption });
  console.log(`Captured ${file}`);
}
async function nav(page, name) {
  active = page;
  await page.getByRole('button', { name, exact: true }).first().click();
}
async function choose(page, locator, text) {
  await locator.click();
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: text }).first().click();
}
async function expandSidebar(page, context) {
  const cdp = await context.newCDPSession(page);
  await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
  const { root } = await cdp.send('DOM.getDocument');
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '.ashcol-sidebar' });
  await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['hover'] });
  await page.waitForFunction(() => document.querySelector('.ashcol-sidebar').getBoundingClientRect().width >= 279);
}
async function refreshJobs(page) {
  await nav(page, 'Job Orders');
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.getByText(mainJob, { exact: true }).waitFor();
  await page.locator('.ant-spin-spinning').waitFor({ state: 'hidden' });
}
const jobRow = page => page.getByRole('row').filter({ hasText: mainJob });
const requestRow = page => page.getByRole('row').filter({ hasText: 'REQ - 0063' });

try {
  await fs.mkdir(out, { recursive: true });
  database = await MongoMemoryReplSet.create({ replSet: { count: 1 }, binary: { version: '7.0.14' } });
  await mongoose.connect(database.getUri('realistic_workflow_screenshots'));
  await initializeDatabase();
  const password = 'Workflow-capture-2026';
  const passwordHash = await hashPassword(password);
  const [manager, tech, otherTech, thirdTech] = await User.insertMany([
    ['ramon.mendoza', 'Ramon Mendoza', 'MANAGER'],
    ['mark.ramos', 'Mark Anthony Ramos', 'EMPLOYEE'],
    ['kevin.bautista', 'Kevin Bautista', 'EMPLOYEE'],
    ['joshua.lim', 'Joshua Lim', 'EMPLOYEE'],
    ['patricia.villanueva', 'Patricia Villanueva', 'ADMIN'],
  ].map(([email, fullName, role]) => ({ email: `${email}@ashcol.com`, fullName, firstName: fullName.split(' ')[0], lastName: fullName.split(' ').at(-1), role, branchId: 'LOCAL-WAREHOUSE', passwordHash })));
  const vans = await ServiceVan.insertMany([
    { _id: vanId, name: 'Mitsubishi L300 - NER 4821', plateNumber: 'NER-4821', driverId: String(tech._id), driverName: tech.fullName, status: 'AVAILABLE' },
    { _id: 'VAN-07', name: 'Toyota Hiace - NCV 7394', plateNumber: 'NCV-7394', driverId: String(otherTech._id), driverName: otherTech.fullName, status: 'ON_FIELD' },
    { _id: 'VAN-02', name: 'Mitsubishi L300 - NDK 2658', plateNumber: 'NDK-2658', driverId: String(thirdTech._id), driverName: thirdTech.fullName, status: 'AVAILABLE' },
  ].map(van => ({ ...van, vehicleType: 'Cargo Van' })));
  const templates = mongoose.mongo.BSON.EJSON.parse(await fs.readFile('demo-data-json/products.json', 'utf8'));
  const catalog = templates.filter(p => p.branchId === 'LOCAL-WAREHOUSE').map(p => {
    const { _id, __v, createdAt, updatedAt, ...data } = p;
    return data;
  });
  const supplier = await Supplier.create({ name: 'Kembla Copper Tube Phils.', contactPerson: 'Fernando Lim', phone: '0917 624 3810', email: 'sales@kembla.example', address: 'Caloocan City', terms: '30 days' });
  const source = await Product.create({ branchId: 'LOCAL-WAREHOUSE', sku: mainSku, name: 'Insulated copper tube pair 1/4 x 3/8 in.', itemType: 'Consumable', category: 'Copper Tubing', brand: 'Kembla', capacity: '1/4 x 3/8 in.', unitOfMeasure: 'METER', unitCost: 485, listPrice: 640, quantity: 42.5, reorderLevel: 10, supplier: supplier.name, supplierId: supplier._id });
  const warehouse = await Product.insertMany(catalog);
  const loaded = await Product.insertMany(warehouse.filter(p => ['TOOL-VAC-2STAGE', 'TOOL-MANIFOLD-DIG', 'MAT-WALL-BRKT-L'].includes(p.sku)).map(p => {
    const { _id, __v, createdAt, updatedAt, ...data } = p.toObject();
    return { ...data, branchId: vanId, quantity: p.itemType === 'Tool / Equipment' ? 1 : 4 };
  }));
  await Movement.insertMany([source, ...warehouse, ...loaded].map(p => ({
    productId: p._id, branchId: p.branchId, sku: p.sku, itemName: p.name, brand: p.brand, category: p.category, itemType: p.itemType, unitOfMeasure: p.unitOfMeasure,
    movementType: 'OPENING', quantityDelta: p.quantity, beforeQuantity: 0, afterQuantity: p.quantity,
    reason: 'Opening balance from verified stock count', performedBy: String(manager._id), performedByName: manager.fullName,
    createdAt: new Date('2026-10-01T08:15:00+08:00'), updatedAt: new Date('2026-10-01T08:15:00+08:00'),
  })));
  const history = [
    [148, 'Drain line repair', 'Mariel Gutierrez', 'Palm Tower, BGC, Taguig', otherTech, vans[1], 'OPEN', true],
    [143, 'Quarterly AC maintenance', 'Lorenzo & Co. Accounting', 'Ortigas Center, Pasig', thirdTech, vans[2], 'OPEN', false],
    [139, 'Split-type general cleaning', 'Eduardo Manalo', 'AFPOVAI Phase 2, Taguig', tech, vans[0], 'OPEN', false],
    [132, 'Compressor replacement', 'Mikaela Soriano', 'Greenwoods, Pasig City', otherTech, vans[1], 'COMPLETED', false],
    [127, 'Low cooling diagnosis', 'Cafe Amihan', 'Poblacion, Makati City', tech, vans[0], 'COMPLETED', false],
    [111, 'Window-type unit relocation', 'Rochelle Panganiban', 'Pembo, Taguig City', tech, vans[0], 'CANCELLED', false],
  ];
  await JobOrder.insertMany(history.map(([number, title, customerName, location, person, van, status, isCurrent], i) => ({
    jobNumber: `JOB${String(number).padStart(4, '0')}`, title, customerName, location, status, isCurrent,
    assignedTechnicianId: person._id, technicianName: person.fullName, vanId: van._id, vanName: van.name, createdByName: manager.fullName,
    createdAt: new Date(Date.parse('2026-10-17T15:10:00+08:00') - i * 86400000),
    ...(isCurrent ? { assignedAt: new Date('2026-10-18T08:00:00+08:00'), assignedByName: manager.fullName } : {}),
    ...(status !== 'OPEN' ? { closedAt: new Date('2026-10-16T16:30:00+08:00'), closedByName: person.fullName } : {}),
  })));
  await Counter.insertMany([{ _id: 'JOB', value: 148 }, { _id: 'material-requests', value: 62 }, { _id: 'USE', value: 186 }, { _id: 'VAN', value: 386 }].filter(entry => !['VAN'].includes(entry._id)));
  await Counter.updateOne({ _id: 'VAN' }, { $set: { value: 386 } }, { upsert: true });
  // A fixed scenario clock keeps the fixture's service-day timestamps consistent.
  // This changes neither application source nor the saved database.
  globalThis.Date = class extends ActualDate {
    constructor(...args) { super(...(args.length ? args : [captureTime])); }
    static now() { return captureTime; }
  };
  const web = express();
  web.use((req, res, next) => req.path.startsWith('/api/') ? app(req, res, next) : next());
  web.use(express.static(path.resolve('../ashcolinventoryreactfinal/ashcolinventory/build')));
  server = await new Promise(resolve => { const s = web.listen(0, '127.0.0.1', () => resolve(s)); });
  browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  async function login(user, loginShot) {
    const context = await browser.newContext({ viewport: { width: 1920, height: 1200 }, deviceScaleFactor: 1, locale: 'en-PH', timezoneId: 'Asia/Manila', reducedMotion: 'reduce' });
    const page = await context.newPage(); active = page; page.setDefaultTimeout(20000);
    await page.clock.setFixedTime(new ActualDate(captureTime));
    pages.push(page);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.getByLabel('Email', { exact: true }).fill(user.email);
    await page.getByLabel('Password', { exact: true }).fill(password);
    await page.getByLabel('Password', { exact: true }).blur();
    if (loginShot) await shot(page, loginShot, 'User Login', `${user.fullName} signs in using a manager account. The password remains masked.`);
    await page.getByRole('button', { name: 'Sign In', exact: true }).click();
    await page.getByRole('button', { name: 'Job Orders', exact: true }).waitFor();
    await expandSidebar(page, context);
    return page;
  }
  const m = await login(manager, '01-user-login.png');
  await at('08:15');
  await nav(m, 'Job Orders');
  await m.getByRole('button', { name: 'Create Job Order', exact: true }).click();
  let d = m.getByRole('dialog');
  await d.getByRole('textbox', { name: 'Job title', exact: true }).fill(mainTitle);
  await d.getByRole('textbox', { name: 'Customer', exact: true }).fill('Elena Robles');
  await d.getByRole('textbox', { name: 'Service location', exact: true }).fill('28 Mabini St., San Antonio, Pasig City');
  await d.getByRole('textbox', { name: 'Description (optional)', exact: true }).fill('Install the bedroom inverter AC. Check copper piping and drainage, pressure-test connections and verify cooling. Contact Ms. Robles before arrival.');
  await d.getByRole('textbox', { name: 'Description (optional)', exact: true }).blur();
  await shot(m, '02-create-job-order.png', 'Create Job Order', 'Ramon enters the installation task, customer, service address, and work instructions.');
  await d.getByRole('combobox', { name: 'Job service vehicle' }).click();
  await m.locator('.ant-select-dropdown:visible').waitFor();
  await shot(m, '03-select-service-van.png', 'Assign Service Van', 'The actual create form selects a vehicle first. Only vehicles with assigned technicians are eligible.');
  await m.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: vans[0].name }).click();
  assert.equal(await d.getByRole('textbox', { name: 'Assigned technician', exact: true }).inputValue(), tech.fullName);
  await shot(m, '04-technician-and-van-assigned.png', 'Assign Technician', 'Selecting the L300 automatically supplies its assigned technician, Mark Anthony Ramos. These assignments are linked in the current UI.');
  await at('08:18');
  await d.getByRole('button', { name: 'Create Job Order', exact: true }).click();
  await d.waitFor({ state: 'hidden' });
  await m.getByText(mainJob, { exact: true }).waitFor();
  await jobRow(m).getByRole('button', { name: 'Assign job', exact: true }).click();
  await m.getByRole('button', { name: 'OK', exact: true }).waitFor();
  await shot(m, '05-dispatch-job-confirmation.png', 'Dispatch the assignment', 'The manager confirms JOB-0149 as the current job for Mark.');
  await m.getByRole('button', { name: 'OK', exact: true }).click();
  await jobRow(m).getByText('Current job', { exact: true }).waitFor();
  await shot(m, '06-manager-assigned-job.png', 'Assignment saved', 'The manager sees JOB-0149 as OPEN and Current job, with the selected technician and service van.');
  await at('08:22');
  const t = await login(tech);
  await refreshJobs(t);
  await jobRow(t).getByText('Current job', { exact: true }).waitFor();
  await shot(t, '07-technician-assigned-job.png', 'Technician Views Assigned Job', 'Mark sees his own job list and the new current installation job. Other technicians\' work is excluded.');
  await jobRow(t).getByRole('button', { name: 'View details', exact: true }).click();
  await t.getByRole('dialog').getByText('Elena Robles', { exact: true }).waitFor();
  await shot(t, '08-technician-job-details.png', 'Technician reviews the work', 'The job details show the customer, address, vehicle, assignment, and installation instructions before work starts.');
  await t.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  await nav(t, 'Material Requests');
  await t.getByRole('button', { name: 'New Request', exact: true }).click();
  d = t.getByRole('dialog');
  for (const [label, option] of [['Request item type', 'Consumable'], ['Request brand', 'Kembla'], ['Request item', source.name]]) await choose(t, d.getByRole('combobox', { name: label, exact: true }), option);
  await d.getByRole('spinbutton', { name: 'Request quantity' }).fill('6');
  await d.getByLabel('Request notes').fill('For JOB-0149: copper piping for Elena Robles bedroom AC installation, San Antonio, Pasig. Allow 0.5 m for routing adjustments.');
  await d.getByLabel('Request notes').blur();
  await shot(t, '09-create-material-request.png', 'Create Material Request', 'Mark requests 6 meters of copper tube pair for JOB-0149. Warehouse availability is 42.5 meters; the receiving L300 is shown on the form.');
  await at('08:27');
  await d.getByRole('button', { name: 'Submit request', exact: true }).click();
  await d.waitFor({ state: 'hidden' });
  await requestRow(t).getByText('PENDING', { exact: true }).waitFor();
  await shot(t, '10-material-request-submitted.png', 'Request submitted', 'REQ-0063 is pending review. Submitting a request does not deduct inventory.');
  await nav(m, 'Material Requests');
  await requestRow(m).getByRole('button', { name: 'Approve', exact: true }).waitFor();
  await shot(m, '11-manager-reviews-request.png', 'Approval', 'The manager reviews the quantity, requester, and receiving vehicle before approval.');
  await at('08:35');
  await requestRow(m).getByRole('button', { name: 'Approve', exact: true }).click();
  await requestRow(m).getByText('APPROVED', { exact: true }).waitFor();
  await shot(m, '12-request-approved.png', 'Request approved', 'REQ-0063 is approved and ready for fulfillment. Warehouse stock remains unchanged at this stage.');
  assert.equal((await Product.findById(source._id)).quantity, 42.5);
  await requestRow(m).getByRole('button', { name: 'Fulfill', exact: true }).click();
  await m.getByRole('button', { name: 'OK', exact: true }).waitFor();
  await shot(m, '13-fulfillment-confirmation.png', 'Fulfillment', 'The manager confirms transfer of the approved materials into Mark\'s assigned service van.');
  await at('08:42');
  await m.getByRole('button', { name: 'OK', exact: true }).click();
  await requestRow(m).getByText('FULFILLED', { exact: true }).waitFor();
  await requestRow(m).getByRole('button', { name: 'Expand row' }).click();
  await m.getByText('Request history', { exact: true }).waitFor();
  await shot(m, '14-request-fulfilled-history.png', 'Approval and fulfillment history', 'The real request history records PENDING, APPROVED, and FULFILLED actions with the responsible personnel.');
  assert.equal((await Product.findById(source._id)).quantity, 36.5);
  assert.equal((await Product.findOne({ branchId: vanId, sku: mainSku })).quantity, 6);
  await nav(m, 'Inventory Catalog');
  await m.getByPlaceholder('Search SKU, name, or brand').fill(mainSku);
  await m.getByRole('row').filter({ hasText: mainSku }).waitFor();
  await shot(m, '15-warehouse-inventory-deduction.png', 'Inventory Deduction', 'Fulfillment reduces warehouse copper tubing from 42.5 to 36.5 meters. The 6 meters are transferred, not yet consumed on the job.');
  await nav(m, 'Stock Ledger');
  await m.getByPlaceholder('Search SKU, item, or reference').fill('REQ0063');
  await m.getByRole('cell', { name: 'REQ - 0063', exact: true }).first().waitFor();
  await m.waitForFunction(() => document.querySelector('.stock-ledger-pagination-info')?.textContent.trim() === 'Showing 1 to 2 of 2 entries');
  await shot(m, '16-stock-movement-recorded.png', 'Stock Movement Recorded', 'The warehouse ledger records the material issue under REQ-0063. Fulfillment also writes the receiving vehicle\'s transfer entry.');
  await nav(t, 'Service Vehicles');
  await t.getByTitle('View vehicle details').click();
  const copperRow = () => t.getByRole('row').filter({ hasText: mainSku });
  await copperRow().waitFor();
  await shot(t, '17-service-van-materials-received.png', 'Materials received by the service van', 'Mark\'s L300 now carries 6 meters of the requested copper tubing, alongside its existing tools and materials.');
  await at('09:20');
  await t.getByLabel('Current status select').selectOption('ARRIVED');
  await t.waitForFunction(() => document.querySelector('[aria-label="Current status select"]')?.value === 'ARRIVED');
  await shot(t, '18-arrived-at-client-site.png', 'Job Progress Updated: arrival', 'The technician updates the vehicle status to Arrived at Client Site. The current app tracks this operational state rather than a job progress percentage.');
  await copperRow().getByRole('button', { name: 'Record Usage', exact: true }).click();
  d = t.getByRole('dialog');
  await t.waitForFunction(() => /^USE - \d+$/.test(document.querySelector('input[aria-label="Usage ID"]')?.value || ''));
  await d.getByRole('spinbutton', { name: 'Quantity Used' }).fill('5.5');
  await d.getByPlaceholder('Describe where the material was installed/used').fill('Installed 5.5 m copper piping for the bedroom AC. Connections pressure-tested, drain checked and cooling verified with Ms. Robles.');
  await d.getByPlaceholder('Describe where the material was installed/used').blur();
  assert.match(await d.getByRole('textbox', { name: 'Current Job Order', exact: true }).inputValue(), /JOB - 0149/);
  await at('11:05');
  await shot(t, '19-record-job-material-usage.png', 'Job Progress Updated: record material usage', 'USE-0187 records 5.5 meters used against the actual current job, JOB-0149. This is separate from the earlier warehouse transfer.');
  await d.getByRole('button', { name: 'Record Usage', exact: true }).click();
  await d.waitFor({ state: 'hidden' });
  await copperRow().getByText('0.5 METER', { exact: true }).waitFor();
  assert.equal((await Product.findOne({ branchId: vanId, sku: mainSku })).quantity, 0.5);
  await shot(t, '20-vehicle-stock-after-usage.png', 'Inventory after job usage', 'After recording 5.5 meters used, the van retains 0.5 meter. Warehouse stock remains 36.5 meters.');
  await refreshJobs(t);
  await jobRow(t).getByRole('button', { name: 'View details', exact: true }).click();
  await t.getByRole('dialog').getByText('USE - 0187', { exact: true }).waitFor();
  await shot(t, '21-job-progress-material-history.png', 'Job Progress Updated: material history', 'The job now displays its recorded material usage, technician, quantity, and installation notes. The job remains OPEN until completion.');
  await t.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  await at('11:20');
  await jobRow(t).getByRole('button', { name: 'Complete', exact: true }).click();
  await t.getByRole('button', { name: 'OK', exact: true }).waitFor();
  await shot(t, '22-technician-completes-job.png', 'Technician Completes Job', 'Mark confirms completion after installing the materials and verifying the service work.');
  await t.getByRole('button', { name: 'OK', exact: true }).click();
  await jobRow(t).getByText('COMPLETED', { exact: true }).waitFor();
  await shot(t, '23-technician-job-completed.png', 'Job completion saved', 'JOB-0149 is COMPLETED and no longer marked as the current job.');
  await refreshJobs(m);
  await jobRow(m).getByText('COMPLETED', { exact: true }).waitFor();
  await jobRow(m).getByRole('button', { name: 'View details', exact: true }).click();
  await m.getByRole('dialog').getByText('USE - 0187', { exact: true }).waitFor();
  await shot(m, '24-job-order-closed.png', 'Job Order Closed', 'The manager reviews the completed job, closing time, closing technician, and preserved material-usage history. There is no separate CLOSED status; completion closes the job.');
  const finalJob = await JobOrder.findOne({ jobNumber: 'JOB0149' });
  assert.equal(finalJob.status, 'COMPLETED'); assert.equal(finalJob.isCurrent, false);
  assert.equal((await PartRequest.findOne({ requestNumber: 'REQ0063' })).status, 'FULFILLED');
  assert.equal(await Movement.countDocuments({ referenceId: 'USE0187', jobId: finalJob._id }), 1);
  assert.deepEqual(errors, []);
  const intro = '# Realistic Job Order Workflow Screenshots\n\nCaptured from the actual current application UI at a 1920 x 1200 desktop viewport. Full-page PNGs include overflow content where needed. All people and customer details are fictional sample records in an isolated temporary database. The saved database and accounts were not modified.\n\n## Scenario\n\nManager: Ramon Mendoza. Technician: Mark Anthony Ramos. Customer: Elena Robles, San Antonio, Pasig City. Vehicle: Mitsubishi L300, NER-4821. Job: JOB-0149. Request: REQ-0063. Usage: USE-0187.\n\nWarehouse copper tubing: 42.5 m -> 36.5 m after fulfillment. Vehicle receives 6 m, uses 5.5 m on the job, and retains 0.5 m.\n\n## How the requested flow maps to the actual UI\n\n- Technician and vehicle assignment are linked: selecting a vehicle in the job form automatically supplies its assigned technician. Dispatch then makes that job current. The screenshots preserve the actual order.\n- Approval does not deduct stock. Fulfillment transfers materials from the warehouse to the vehicle and writes ledger records in the same operation.\n- The current UI has no separate job progress percentage or IN PROGRESS status. Arrival is represented by vehicle status, and work activity is evidenced by material usage linked to the current job.\n- The material request form has no job selector. The job number is stated in the request notes; the later usage transaction links directly to JOB-0149.\n- Completing a job closes it with status COMPLETED, clears its current assignment, and preserves usage history. There is no separate CLOSED button or status.\n\n## Screenshots in order\n\n';
  await fs.writeFile(path.join(out, 'README.md'), intro + 'Scenario timestamps use a fixed test clock on October 18, 2026: login at 08:10, job creation at 08:18, request submission at 08:27, approval at 08:35, fulfillment at 08:42, arrival at 09:20, material usage at 11:05, and completion at 11:20 (Asia/Manila). These are fictional demonstration times, not actual service history.\n\n' + steps.map((s, i) => `${i + 1}. **${s.title}** — [${s.file}](${s.file})\n\n   ${s.caption}\n`).join('\n'));
  await fs.writeFile(path.join(out, 'manifest.json'), JSON.stringify({ viewport: { width: 1920, height: 1200 }, isolatedDatabase: true, jobNumber: 'JOB0149', requestNumber: 'REQ0063', usageId: 'USE0187', balances: { warehouseBefore: 42.5, warehouseAfter: 36.5, vehicleReceived: 6, jobUsage: 5.5, vehicleRemaining: 0.5 }, steps }, null, 2));
  const esc = s => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
  await fs.writeFile(path.join(out, 'index.html'), `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ASHCOL Job Order Workflow</title><style>body{font:16px/1.6 Segoe UI,Arial,sans-serif;color:#182b24;background:#f3f7f5;margin:0}main{max-width:1400px;margin:40px auto;padding:0 24px}h1{margin-bottom:8px}article{background:white;border:1px solid #d6e1da;border-radius:12px;margin:28px 0;padding:24px}img{display:block;width:100%;height:auto;border:1px solid #e2e9e4;margin-top:16px}a{color:#176039}nav{display:flex;gap:10px;flex-wrap:wrap}nav a{background:white;padding:6px 12px;border-radius:8px}@media print{article{break-before:page;border:0;padding:0}nav{display:none}}</style><main><h1>Job Order Workflow</h1><p>Actual application screens with fictional sample records. JOB-0149 · REQ-0063 · USE-0187</p><p>Ramon Mendoza → Mark Anthony Ramos · Elena Robles, Pasig City · Mitsubishi L300, NER-4821</p><p><a href="README.md">Read the workflow notes</a>. Selecting a vehicle also selects its technician; arrival and material usage show progress; COMPLETED is the closed state.</p><nav>${steps.map((s, i) => `<a href="#step${i + 1}">${i + 1}</a>`).join('')}</nav>${steps.map((s, i) => `<article id="step${i + 1}"><h2>${i + 1}. ${esc(s.title)}</h2><p>${esc(s.caption)}</p><a href="${s.file}" target="_blank"><img loading="lazy" src="${s.file}" alt="${esc(s.title)}"></a></article>`).join('')}</main></html>`);
  console.log(`Complete: ${steps.length} screenshots saved to ${out}`);
} catch (error) {
  if (active) {
    await active.screenshot({ path: path.join(out, 'capture-error.png'), fullPage: true }).catch(() => {});
    console.error((await active.locator('body').innerText().catch(() => '')).slice(-2500));
  }
  throw error;
} finally {
  globalThis.Date = ActualDate;
  if (browser) await browser.close();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await mongoose.disconnect();
  if (database) await database.stop();
}
