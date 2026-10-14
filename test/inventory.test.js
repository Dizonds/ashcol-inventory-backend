// Integration tests use an isolated temporary replica set, never server/.env.
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import supertest from "supertest";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import app from "../src/app.js";
import { initializeDatabase } from "../src/setup.js";
import { hashPassword } from "../src/auth.js";
import {
  Product,
  Movement,
  User,
  ServiceVan,
  PartRequest,
  Session,
} from "../src/models.js";

let database;
let adminToken;
let employeeToken;
let managerToken;
const http = supertest(app);
const branchId = "LOCAL-WAREHOUSE";
const serviceVanId = "VAN-TEST";
let sequence = 0;
function call(method, path, data, token = adminToken) {
  const request = http[method]("/api" + path).set(
    "Authorization",
    `Bearer ${token}`,
  );
  return method === "get" || method === "delete"
    ? request.query(data || {})
    : request.send(data || {});
}
function product(overrides = {}) {
  sequence += 1;
  return {
    branchId,
    sku: `TEST-${sequence}`,
    name: "Aircon Unit",
    itemType: "AC Unit",
    category: "Split Type",
    brand: "Carrier",
    capacity: "1.0 HP",
    unitOfMeasure: "UNIT",
    unitCost: 100,
    listPrice: 150,
    quantity: 5,
    reorderLevel: 0,
    ...overrides,
  };
}
function create(overrides) {
  return call("post", "/products", product(overrides)).then((response) => {
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body;
  });
}
function movement(item, delta, overrides = {}) {
  return call("patch", `/products/${item.id}/stock`, {
    branchId,
    delta,
    reason:
      delta > 0
        ? "Supplier Delivery / Restock"
        : "Client Installation / Site Project",
    notes: "Test receipt",
    workOrderId: "AC-001",
    ...overrides,
  });
}

before(async () => {
  database = await MongoMemoryReplSet.create({
    replSet: { count: 1 },
    binary: { version: "7.0.14" },
  });
  await mongoose.connect(database.getUri(), { dbName: "inventory_test" });
  await initializeDatabase();
  await ServiceVan.create({ _id: serviceVanId, name: "Test Service Van" });
  const passwordHash = await hashPassword("Test-password-2026");
  await User.insertMany([
    {
      email: "admin@example.test",
      fullName: "Test Admin",
      role: "ADMIN",
      branchId,
      passwordHash,
    },
    {
      email: "employee@example.test",
      fullName: "Test Employee",
      role: "EMPLOYEE",
      branchId,
      passwordHash,
    },
    {
      email: "manager@example.test",
      fullName: "Test Manager",
      role: "MANAGER",
      branchId,
      passwordHash,
    },
  ]);
  const employee = await User.findOne({ email: "employee@example.test" });
  await ServiceVan.updateOne(
    { _id: serviceVanId },
    { driverId: String(employee._id), driverName: employee.fullName },
  );
  for (const email of ["admin", "employee", "manager"]) {
    const response = await http
      .post("/api/auth/login")
      .send({ email: `${email}@example.test`, password: "Test-password-2026" });
    assert.equal(response.status, 200);
    assert.equal(response.body.user.passwordHash, undefined);
    if (email === "admin") adminToken = response.body.token;
    if (email === "employee") employeeToken = response.body.token;
    if (email === "manager") managerToken = response.body.token;
  }
});
after(async () => {
  await mongoose.disconnect();
  if (database) await database.stop();
});

test("requires a valid password and token", async () => {
  assert.equal((await http.get("/api/products")).status, 401);
  assert.equal(
    (
      await http
        .post("/api/auth/login")
        .send({ email: "admin@example.test", password: "wrong" })
    ).status,
    401,
  );
  assert.equal((await call("get", "/auth/me")).body.role, "ADMIN");
});

test("enforces branch ownership and write permissions on the API", async () => {
  assert.equal(
    (await call("get", "/products", { branchId: "UNKNOWN-SCOPE" }, employeeToken))
      .status,
    404,
  );
  assert.equal(
    (await call("get", "/movements", { branchId: "UNKNOWN-SCOPE" }, managerToken))
      .status,
    404,
  );
  assert.equal(
    (await call("post", "/products", product(), employeeToken)).status,
    403,
  );
  assert.equal((await call("post", "/users", {}, employeeToken)).status, 403);
  assert.equal(
    (await call("post", "/transfers", {}, managerToken)).status,
    403,
  );
});

test("keeps zero reorder levels and rejects duplicate SKUs within a branch", async () => {
  const data = product();
  const response = await call("post", "/products", data);
  assert.equal(response.body.reorderLevel, 0);
  assert.equal(
    (await call("post", "/products", { ...data, sku: data.sku.toLowerCase() }))
      .status,
    409,
  );
  assert.equal(
    (await call("post", "/products", { ...data, branchId: serviceVanId }))
      .status,
    201,
  );
});

test("validates negative amounts, whole-unit stock and material precision", async () => {
  assert.equal((await call("post", "/products", product({ quantity: [] }))).status, 400);
  assert.equal((await call("post", "/products", product({ quantity: " " }))).status, 400);
  assert.equal(
    (await call("post", "/products", product({ quantity: -1 }))).status,
    400,
  );
  assert.equal(
    (await call("post", "/products", product({ quantity: 1.5 }))).status,
    400,
  );
  const cylItem = await create({
    itemType: "Material / Part",
    category: "Refrigerants",
    unitOfMeasure: "CYL",
    quantity: 10,
    reorderLevel: 2,
  });
  assert.equal(cylItem.unitOfMeasure, "CYL");
  assert.equal(
    (
      await call(
        "post",
        "/products",
        product({
          itemType: "Material / Part",
          category: "Refrigerants",
          unitOfMeasure: "CYL",
          quantity: 2.5,
        }),
      )
    ).status,
    400,
  );
  const pairItem = await create({
    itemType: "Material / Part",
    category: "Installation Materials",
    unitOfMeasure: "PAIR",
    quantity: 5,
    reorderLevel: 1,
  });
  assert.equal(pairItem.unitOfMeasure, "PAIR");
  const item = await create({
    itemType: "Material / Part",
    category: "Copper Tubing",
    unitOfMeasure: "METER",
    quantity: 1.5,
    reorderLevel: 0.5,
  });
  const result = await movement(item, -0.25);
  assert.equal(result.status, 200);
  assert.equal(result.body.quantity, 1.25);
  assert.equal((await movement(item, 0.0001)).status, 400);
});

test("rejects insufficient stock without saving a misleading movement", async () => {
  const item = await create({ quantity: 3 });
  const before = await Movement.countDocuments({ productId: item.id });
  assert.equal((await movement(item, -5)).status, 409);
  assert.equal((await Product.findById(item.id)).quantity, 3);
  assert.equal(await Movement.countDocuments({ productId: item.id }), before);
});

test("concurrent dispatches cannot oversell and balances reconcile with the ledger", async () => {
  const item = await create({ quantity: 5 });
  const responses = await Promise.all([movement(item, -4), movement(item, -4)]);
  assert.deepEqual(
    responses.map((response) => response.status).sort(),
    [200, 409],
  );
  const saved = await Product.findById(item.id);
  const ledger = await Movement.find({ productId: item.id });
  assert.equal(saved.quantity, 1);
  assert.equal(
    ledger.reduce((total, entry) => total + entry.quantityDelta, 0),
    1,
  );
  const dispatch = ledger.filter((entry) => entry.quantityDelta < 0)[0];
  assert.equal(dispatch.beforeQuantity, 5);
  assert.equal(dispatch.afterQuantity, 1);
  assert.equal(dispatch.performedByName, "Test Admin");
});

test("rolls back the stock balance if writing the ledger fails", async () => {
  const item = await create();
  const original = Movement.create;
  Movement.create = () => Promise.reject(new Error("Simulated ledger failure"));
  try {
    assert.equal((await movement(item, -1)).status, 500);
  } finally {
    Movement.create = original;
  }
  assert.equal((await Product.findById(item.id)).quantity, 5);
});

test("spec edits cannot overwrite quantity or change the measurement unit", async () => {
  const item = await create();
  assert.equal(
    (await call("put", `/products/${item.id}`, { ...item, quantity: -5 }))
      .status,
    400,
  );
  const edit = { ...item, name: "Updated name" };
  delete edit.quantity;
  assert.equal(
    (await call("put", `/products/${item.id}`, edit, employeeToken)).status,
    403,
  );
  assert.equal(
    (
      await call("put", `/products/${item.id}`, {
        ...edit,
        unitOfMeasure: "KG",
      })
    ).status,
    400,
  );
  assert.equal((await call("put", `/products/${item.id}`, edit)).status, 200);
  assert.equal((await Product.findById(item.id)).quantity, 5);
});

test("rejects invalid reasons and empty notes on stock movements", async () => {
  const item = await create();
  assert.equal(
    (await movement(item, 1, { reason: "Warehouse Transfer In" })).status,
    400,
  );
  assert.equal((await movement(item, 1, { notes: "" })).status, 400);
});

test("movement confirmation reserves the exact saved ticket and cannot post it twice", async () => {
  const item = await create();
  const reference = await call("post", "/movement-tickets", { movementType: "STOCK_IN" }, managerToken);
  assert.equal(reference.status, 201);
  assert.match(reference.body.referenceId, /^STI\d{4,}$/);
  const body = {
    branchId, delta: 2, reason: "Supplier Delivery / Restock", notes: "Receipt 100",
    referenceId: reference.body.referenceId,
  };
  assert.equal((await call("patch", `/products/${item.id}/stock`, body, adminToken)).status, 403);
  const posts = await Promise.all([
    call("patch", `/products/${item.id}/stock`, body, managerToken),
    call("patch", `/products/${item.id}/stock`, body, managerToken),
  ]);
  assert.deepEqual(posts.map((response) => response.status).sort(), [200, 409]);
  assert.equal((await Product.findById(item.id)).quantity, 7);
  const entries = await Movement.find({ referenceId: reference.body.referenceId });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].brand, item.brand);
  assert.equal(entries[0].itemType, item.itemType);
  assert.equal(entries[0].category, item.category);
});

test("stock-out ticket validation and failed postings preserve a retryable reservation", async () => {
  const item = await create({ quantity: 2 });
  const reference = await call("post", "/movement-tickets", { movementType: "STOCK_OUT" });
  assert.equal(reference.status, 201);
  assert.match(reference.body.referenceId, /^STO\d{4,}$/);
  assert.equal((await call("post", "/movement-tickets", { movementType: "STOCK_IN" }, employeeToken)).status, 403);
  assert.equal((await call("post", "/movement-tickets", { movementType: "OTHER" })).status, 400);
  const body = { branchId, delta: -3, reason: "Parts Sale", notes: "Invoice 100", referenceId: reference.body.referenceId };
  assert.equal((await call("patch", `/products/${item.id}/stock`, body)).status, 409);
  assert.equal((await Product.findById(item.id)).quantity, 2);
  assert.equal((await call("patch", `/products/${item.id}/stock`, { ...body, delta: 1, reason: "Supplier Delivery / Restock" })).status, 400);
  assert.equal((await call("patch", `/products/${item.id}/stock`, { ...body, referenceId: "STO99999999" })).status, 400);
  assert.equal((await call("patch", `/products/${item.id}/stock`, { ...body, delta: -1 })).status, 200);
  assert.equal((await Product.findById(item.id)).quantity, 1);
});

test("movement tickets are unique when several confirmations open simultaneously", async () => {
  const results = await Promise.all(Array.from({ length: 6 }, () =>
    call("post", "/movement-tickets", { movementType: "STOCK_IN" })));
  for (const response of results) assert.equal(response.status, 201);
  assert.equal(new Set(results.map((response) => response.body.referenceId)).size, 6);
});

test("older ledger and request rows get catalog details while saved snapshots stay unchanged", async () => {
  const item = await create();
  const legacyMovement = await Movement.create({ branchId, productId: item.id, itemName: item.name, quantityDelta: 1 });
  const legacyRequest = await PartRequest.create({ branchId, productId: item.id, quantityNeeded: 1, workOrderId: "OLD-JOB" });
  const requests = await call("get", "/requests", { branchId });
  const request = requests.body.find((entry) => entry.id === String(legacyRequest._id));
  assert.equal(request.brand, item.brand);
  assert.equal(request.itemType, item.itemType);
  assert.equal(request.category, item.category);
  assert.equal(request.productId, item.id);
  const ledger = await call("get", "/movements", { branchId, search: item.name, pageSize: 100 });
  const entry = ledger.body.items.find((entry) => entry.id === String(legacyMovement._id));
  assert.equal(entry.brand, item.brand);
  assert.equal(entry.itemType, item.itemType);
  assert.equal(entry.category, item.category);
  await movement(item, 1);
  const snapshot = await Movement.findOne({ productId: item.id, movementType: "STOCK_IN" });
  await Product.updateOne({ _id: item.id }, { $set: { brand: "Daikin" } });
  const savedLedger = await call("get", "/movements", { branchId, search: snapshot.referenceId });
  assert.equal(savedLedger.body.items[0].brand, item.brand);
});

test("request approval does not deduct stock; fulfillment deducts exactly once", async () => {
  const item = await create({ quantity: 5 });
  const reference = await call("get", "/requests/reference", {}, employeeToken);
  assert.equal(reference.status, 200);
  assert.match(reference.body.requestNumber, /^REQ\d{4,}$/);
  const response = await call(
    "post",
    "/requests",
    { branchId, productId: item.id, quantityNeeded: 2, requestId: reference.body.id },
    employeeToken,
  );
  assert.equal(response.status, 201);
  assert.equal(response.body.id, reference.body.id);
  assert.equal(response.body.requestNumber, reference.body.requestNumber);
  assert.equal(response.body.workOrderId, reference.body.requestNumber);
  assert.equal(response.body.brand, item.brand);
  assert.equal(response.body.itemType, item.itemType);
  assert.equal(response.body.category, item.category);
  const path = `/requests/${response.body.id}`;
  assert.equal(
    (await call("patch", path, { branchId, status: "FULFILLED" })).status,
    409,
  );
  assert.equal(
    (await call("patch", path, { branchId, status: "APPROVED" }, employeeToken))
      .status,
    403,
  );
  assert.equal(
    (await call("patch", path, { branchId, status: "APPROVED" }, managerToken))
      .status,
    200,
  );
  assert.equal((await Product.findById(item.id)).quantity, 5);
  const results = await Promise.all([
    call("patch", path, { branchId, status: "FULFILLED" }),
    call("patch", path, { branchId, status: "FULFILLED" }),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
  assert.equal((await Product.findById(item.id)).quantity, 3);
  assert.equal(
    await Movement.countDocuments({ referenceId: response.body.id }),
    1,
  );
  const list = await call("get", "/requests", { branchId }, employeeToken);
  const saved = list.body.find((entry) => entry.id === response.body.id);
  assert.equal(saved.requestNumber, reference.body.requestNumber);
  assert.deepEqual(saved.history.map((event) => event.status), ["PENDING", "APPROVED", "FULFILLED"]);
  assert.deepEqual(saved.history.map((event) => event.performedByName), ["Test Employee", "Test Manager", "Test Admin"]);
  const ledger = await call("get", "/movements", { branchId, search: reference.body.requestNumber });
  assert.equal(ledger.body.total, 1);
  assert.equal(ledger.body.items[0].referenceId, response.body.id);
  assert.equal(ledger.body.items[0].requestNumber, reference.body.requestNumber);
});

test("request IDs are unique and reject malformed or reused IDs", async () => {
  const item = await create();
  const first = await call("get", "/requests/reference", {}, employeeToken);
  const second = await call("get", "/requests/reference", {}, employeeToken);
  assert.notEqual(first.body.id, second.body.id);
  assert.equal(Number(second.body.requestNumber.slice(3)), Number(first.body.requestNumber.slice(3)) + 1);
  const body = { branchId, productId: item.id, quantityNeeded: 1, requestId: first.body.id };
  assert.equal((await call("post", "/requests", { ...body, requestId: "invalid" }, employeeToken)).status, 400);
  assert.equal((await call("post", "/requests", { ...body, requestId: String(new mongoose.Types.ObjectId()) }, employeeToken)).status, 400);
  assert.equal((await call("post", "/requests", body, managerToken)).status, 403);
  assert.equal((await call("post", "/requests", body, employeeToken)).status, 201);
  assert.equal((await call("post", "/requests", body, employeeToken)).status, 409);
  assert.equal((await Product.findById(item.id)).quantity, 5);
});

test("short request numbers remain unique under concurrency and database reinitialization", async () => {
  await initializeDatabase();
  const references = await Promise.all(Array.from({ length: 8 }, () =>
    call("get", "/requests/reference", {}, employeeToken)));
  const values = references.map((response) => {
    assert.equal(response.status, 200);
    assert.match(response.body.requestNumber, /^REQ\d{4,}$/);
    return Number(response.body.requestNumber.slice(3));
  });
  assert.equal(new Set(values).size, 8);
  await initializeDatabase();
  const next = await call("get", "/requests/reference", {}, employeeToken);
  assert.equal(Number(next.body.requestNumber.slice(3)), Math.max(...values) + 1);
});

test("existing requests receive stable short numbers without losing history or ledger links", async () => {
  const item = await create();
  const legacy = await PartRequest.create({
    branchId, productId: item.id, quantityNeeded: 1, workOrderId: "OLD-JOB-123",
    status: "FULFILLED", requestedBy: "legacy-user", requestedByName: "Legacy Technician",
    history: [{ status: "PENDING", performedByName: "Legacy Technician", at: new Date() }],
  });
  const movement = await Movement.create({
    branchId, productId: item.id, referenceId: String(legacy._id),
    movementType: "REQUEST_ISSUE", workOrderId: "OLD-JOB-123", quantityDelta: -1,
  });
  await initializeDatabase();
  const saved = await PartRequest.findById(legacy._id);
  assert.match(saved.requestNumber, /^REQ\d{4,}$/);
  assert.equal(saved.workOrderId, "OLD-JOB-123");
  assert.equal(saved.history[0].performedByName, "Legacy Technician");
  const ledger = await call("get", "/movements", { branchId, search: saved.requestNumber });
  assert.equal(ledger.body.total, 1);
  assert.equal(ledger.body.items[0].id, String(movement._id));
  assert.equal(ledger.body.items[0].referenceId, String(legacy._id));
  assert.equal(ledger.body.items[0].workOrderId, "OLD-JOB-123");
  await initializeDatabase();
  assert.equal((await PartRequest.findById(legacy._id)).requestNumber, saved.requestNumber);
});

test("insufficient-stock fulfillment rolls back the request status", async () => {
  const item = await create({ quantity: 1 });
  const response = await call(
    "post",
    "/requests",
    { branchId, productId: item.id, quantityNeeded: 3, workOrderId: "AC-FAIL" },
    employeeToken,
  );
  const path = `/requests/${response.body.id}`;
  await call("patch", path, { branchId, status: "APPROVED" });
  assert.equal(
    (await call("patch", path, { branchId, status: "FULFILLED" })).status,
    409,
  );
  assert.equal(
    (await PartRequest.findById(response.body.id)).status,
    "APPROVED",
  );
  assert.deepEqual((await PartRequest.findById(response.body.id)).history.map((event) => event.status), ["PENDING", "APPROVED"]);
  assert.equal(
    (await call("patch", path, { branchId, status: "DENIED" })).status,
    400,
  );
  assert.equal(
    (
      await call("patch", path, {
        branchId,
        status: "DENIED",
        decisionReason: "Cancelled job",
      })
    ).status,
    200,
  );
  const denied = await PartRequest.findById(response.body.id);
  assert.deepEqual(denied.history.map((event) => event.status), ["PENDING", "APPROVED", "DENIED"]);
  assert.equal(denied.history.at(-1).reason, "Cancelled job");
});

test("transfers save two linked movements and preserve the combined quantity", async () => {
  const item = await create({ quantity: 5 });
  const response = await call("post", "/transfers", {
    branchId,
    productId: item.id,
    destinationId: serviceVanId,
    quantity: 2,
    reason: "Transfer receipt 001",
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  assert.equal((await Product.findById(item.id)).quantity, 3);
  assert.equal(
    (await Product.findOne({ sku: item.sku, branchId: serviceVanId })).quantity,
    2,
  );
  const records = await Movement.find({
    referenceId: response.body.referenceId,
  });
  assert.equal(records.length, 2);
  assert.equal(
    records.reduce((sum, entry) => sum + entry.quantityDelta, 0),
    0,
  );
});

test("a destination mismatch rolls back both sides of a transfer", async () => {
  const item = await create();
  await create({
    sku: item.sku,
    branchId: serviceVanId,
    name: "Different item",
  });
  assert.equal(
    (
      await call("post", "/transfers", {
        branchId,
        productId: item.id,
        destinationId: serviceVanId,
        quantity: 2,
        reason: "Mismatch",
      })
    ).status,
    409,
  );
  assert.equal((await Product.findById(item.id)).quantity, 5);
});

test("assigned employees can record material used from their service van", async () => {
  const item = await create({ branchId: serviceVanId, quantity: 5 });
  const response = await call(
    "post",
    `/service-vans/${serviceVanId}/consume`,
    {
      productId: item.id,
      quantity: 2,
      workOrderId: "JOB-2026-001",
      notes: "Installed during client site repair",
    },
    employeeToken,
  );
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.quantity, 3);
  const movement = await Movement.findOne({
    productId: item.id,
    movementType: "JOB_CONSUMPTION",
  });
  assert.equal(movement.workOrderId, "JOB-2026-001");
  assert.equal(movement.quantityDelta, -2);
  const ledger = await call(
    "get",
    "/movements",
    { branchId, search: "JOB-2026-001" },
    employeeToken,
  );
  assert.equal(ledger.status, 200);
  assert.equal(ledger.body.total, 1);
});

test("archiving requires zero stock and no open requests; restore preserves identity", async () => {
  const stocked = await create();
  assert.equal(
    (await call("delete", `/products/${stocked.id}`, { branchId })).status,
    409,
  );
  const item = await create({ quantity: 0 });
  const response = await call("post", "/requests", {
    branchId,
    productId: item.id,
    quantityNeeded: 1,
    workOrderId: "AC-ARCHIVE",
  });
  assert.equal(
    (await call("delete", `/products/${item.id}`, { branchId })).status,
    409,
  );
  await call("patch", `/requests/${response.body.id}`, {
    branchId,
    status: "DENIED",
    decisionReason: "No longer needed",
  });
  assert.equal(
    (await call("delete", `/products/${item.id}`, { branchId })).status,
    200,
  );
  assert.equal((await Product.findById(item.id)).archived, true);
  assert.equal((await movement(item, 1)).status, 404);
  assert.equal(
    (await call("post", `/products/${item.id}/restore`, { branchId })).body.id,
    item.id,
  );
});

test("ledger pagination reaches older records and treats search as literal text", async () => {
  const item = await create();
  await Movement.insertMany(
    Array.from({ length: 105 }, (_, index) => ({
      productId: item.id,
      branchId,
      sku: item.sku,
      itemName: "Search (literal)",
      movementType: "DETAILS",
      quantityDelta: 0,
      reason: `History ${index}`,
    })),
  );
  const result = await call("get", "/movements", {
    branchId,
    search: item.sku,
    page: 8,
    pageSize: 15,
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.total, 106);
  assert.equal(result.body.items.length, 1);
  assert.equal(
    (await call("get", "/movements", { branchId, search: "(literal)" })).body
      .total,
    105,
  );
  assert.equal(
    (await call("get", "/movements", { branchId, search: ".*" })).body.total,
    0,
  );
});

test("logout and expired sessions are rejected by the server", async () => {
  const login = await http
    .post("/api/auth/login")
    .send({ email: "employee@example.test", password: "Test-password-2026" });
  await call("post", "/auth/logout", {}, login.body.token);
  assert.equal(
    (await call("get", "/auth/me", {}, login.body.token)).status,
    401,
  );
  const user = await User.findOne({ email: "manager@example.test" });
  await Session.updateMany(
    { userId: user._id },
    { $set: { expiresAt: new Date(0) } },
  );
  assert.equal((await call("get", "/auth/me", {}, managerToken)).status, 401);
});

test("administrator can create accounts for the Taguig warehouse", async () => {
  const response = await call("post", "/users", {
    email: "new@example.test",
    password: "New-password-2026",
    fullName: "New Employee",
    role: "EMPLOYEE",
    branchId,
  });
  assert.equal(response.status, 201);
  assert.equal(response.body.passwordHash, undefined);
  const login = await http
    .post("/api/auth/login")
    .send({ email: "new@example.test", password: "New-password-2026" });
  assert.equal(login.status, 200);
  assert.equal(login.body.user.branchId, branchId);
  const spaced = await call("post", "/users", {
    email: "spaced@example.test",
    password: "Pa ss  word",
    fullName: "Spaced Password",
    role: "EMPLOYEE",
    branchId,
  });
  assert.equal(spaced.status, 400);
});

test("legacy migration assigns explicit ownership without inventing historical balances", async () => {
  const legacy = product({ sku: "LEGACY-ONE" });
  delete legacy.branchId;
  const inserted = await Product.collection.insertOne(legacy);
  const oldMovement = await Movement.collection.insertOne({
    sku: "LEGACY-ONE",
    itemName: legacy.name,
    quantityDelta: 5,
    movementType: "STOCK_IN",
    date: "2026-09-01",
  });
  await promisify(execFile)(
    process.execPath,
    ["scripts/migrate.js", branchId],
    {
      cwd: process.cwd(),
      env: { ...process.env, MONGO_URI: database.getUri("inventory_test") },
    },
  );
  const migrated = await Product.findById(inserted.insertedId);
  assert.equal(migrated.branchId, branchId);
  const movement = await Movement.findById(oldMovement.insertedId);
  assert.equal(String(movement.productId), String(inserted.insertedId));
  assert.equal(movement.beforeQuantity, undefined);
  assert.equal(movement.performedByName, undefined);
  assert.equal(movement.date, "2026-09-01");
});

test("legacy migration refuses ambiguous duplicate SKUs without partial updates", async () => {
  const first = product({ sku: "LEGACY-DUP" });
  const second = product({ sku: "legacy-dup" });
  delete first.branchId;
  delete second.branchId;
  const inserted = await Product.collection.insertMany([first, second]);
  try {
    await assert.rejects(
      promisify(execFile)(process.execPath, ["scripts/migrate.js", branchId], {
        cwd: process.cwd(),
        env: { ...process.env, MONGO_URI: database.getUri("inventory_test") },
      }),
    );
    assert.equal(
      (await Product.findById(inserted.insertedIds[0])).branchId,
      undefined,
    );
    assert.equal(
      (await Product.findById(inserted.insertedIds[1])).branchId,
      undefined,
    );
  } finally {
    await Product.deleteMany({
      _id: { $in: Object.values(inserted.insertedIds) },
    });
  }
});
