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
import { assignExistingTransferNumbers } from "../src/transfer-numbers.js";
import {
  Product,
  Movement,
  User,
  ServiceVan,
  PartRequest,
  Session,
  JobOrder,
  Supplier,
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

async function createJob(overrides = {}, token = managerToken, makeCurrent = true) {
  const technician = await User.findOne({ email: "employee@example.test" });
  const response = await call("post", "/job-orders", {
    title: "Air conditioner installation", customerName: "Test customer", location: "Taguig",
    vanId: serviceVanId, assignedTechnicianId: String(technician._id), ...overrides,
  }, token);
  assert.equal(response.status, 201, JSON.stringify(response.body));
  if (makeCurrent) {
    const assigned = await call("patch", `/job-orders/${response.body.id}/assignment`, {}, token);
    assert.equal(assigned.status, 200, JSON.stringify(assigned.body));
    return assigned.body;
  }
  return response.body;
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

async function removalAccount(label, role = "EMPLOYEE") {
  const response = await call("post", "/users", {
    firstName: "Removal", lastName: "Tester", email: `${label}@example.test`,
    password: "Removal-test-2026", role, branchId,
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body;
}

test("live events notify separate authenticated sessions when a vehicle is assigned", async () => {
  assert.equal((await http.get("/api/events")).status, 401);
  const employee = await removalAccount("live-technician");
  const login = await call("post", "/auth/login", { email: employee.email, password: "Removal-test-2026" });
  const token = login.body.token;
  const vanId = "VAN-LIVE-TEST";
  assert.equal((await call("post", "/service-vans", { id: vanId, name: "Live Test Vehicle" })).status, 201);
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  const controller = new AbortController();
  const streams = [];
  function eventReader(reader) {
    let buffer = "";
    const decoder = new TextDecoder();
    return async function nextEvent() {
      const timer = setTimeout(() => controller.abort(), 5000);
      try {
        while (!buffer.includes("\n\n")) {
          const { value, done } = await reader.read();
          assert.equal(done, false);
          buffer += decoder.decode(value, { stream: true });
        }
        const index = buffer.indexOf("\n\n");
        const frame = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        return frame;
      } finally { clearTimeout(timer); }
    };
  }
  try {
    for (const sessionToken of [adminToken, token]) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/events`, {
        headers: { Authorization: `Bearer ${sessionToken}` }, signal: controller.signal,
      });
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type"), /text\/event-stream/);
      const next = eventReader(response.body.getReader());
      assert.match(await next(), /event: ready/);
      streams.push(next);
    }
    assert.deepEqual((await call("get", "/service-vans", {}, token)).body, []);
    const assigned = await call("patch", `/service-vans/${vanId}/driver`, { driverId: employee.id });
    assert.equal(assigned.status, 200, JSON.stringify(assigned.body));
    for (const next of streams) assert.match(await next(), /event: change/);
    assert.deepEqual((await call("get", "/service-vans", {}, token)).body.map((van) => van.id), [vanId]);
    assert.equal((await call("get", "/service-vans", {}, employeeToken)).body.some((van) => van.id === vanId), false);
  } finally {
    controller.abort();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await call("patch", `/service-vans/${vanId}/driver`, { driverId: "" });
    await call("delete", `/service-vans/${vanId}`);
    await call("delete", `/users/${employee.id}`);
  }
});

test("brand logo API returns logo metadata and validates missing brands", async () => {
  const created = await call("post", "/brands", { name: "Logo API Test" });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => ({ ok: true, status: 200, json: async () =>
    url.includes("summary") ? { wikibase_item: "Q123" } : { entities: { Q123: { claims: { P154: [
      { rank: "normal", mainsnak: { datavalue: { value: "Example logo.svg" } } },
    ] } } } },
  });
  try {
    const result = await call("get", `/brands/${created.body.id}/logo`, {}, employeeToken);
    assert.equal(result.status, 200);
    assert.equal(result.body.name, "Logo API Test");
    assert.equal(result.body.brandId, created.body.id);
    assert.match(result.body.logoUrl, /^https:\/\/upload.wikimedia.org\/.+Example_logo.svg$/);
    assert.match(result.body.sourceUrl, /^https:\/\/commons.wikimedia.org\/wiki\/File:/);
  } finally {
    globalThis.fetch = originalFetch;
    await call("delete", `/brands/${created.body.id}`);
  }
  assert.equal((await call("get", `/brands/${created.body.id}/logo`)).status, 404);
  assert.equal((await call("get", "/brands/not-an-id/logo")).status, 400);
});

test("brand removal enforces management permissions and preserves existing product details", async () => {
  const created = await call("post", "/brands", { name: "Removal Test Brand" });
  assert.equal(created.status, 201);
  const item = await create({ brand: "Removal Test Brand" });
  const path = `/brands/${created.body.id}`;
  assert.equal((await call("delete", path, {}, employeeToken)).status, 403);
  assert.equal((await call("get", "/brands")).body.some((brand) => brand.id === created.body.id), true);
  assert.equal((await call("delete", path, {}, managerToken)).status, 200);
  assert.equal((await call("get", "/brands")).body.some((brand) => brand.id === created.body.id), false);
  assert.equal((await Product.findById(item.id)).brand, "Removal Test Brand");
  assert.equal((await call("delete", path)).status, 404);
  assert.equal((await call("delete", "/brands/invalid-id")).status, 400);
});

test("supplier validation rejects invalid registrations and edits without overwriting records", async () => {
  for (const phone of ["abc1234567", "123", "1234567890123456", "12+3456789", "-------"]) {
    const response = await call("post", "/suppliers", { name: "Invalid Supplier", phone });
    assert.equal(response.status, 400, JSON.stringify(response.body));
  }
  for (const input of [{ name: "   " }, { name: "Invalid Supplier", email: "invalid-email" }, { name: "Invalid Supplier", contactPerson: false }, { name: "Invalid Supplier", address: "x".repeat(201) }]) {
    assert.equal((await call("post", "/suppliers", input)).status, 400);
  }
  const registered = await call("post", "/suppliers", {
    name: " Validation Supplier ", phone: "+63 917 845 2310", email: " SALES@EXAMPLE.COM ",
  });
  assert.equal(registered.status, 201, JSON.stringify(registered.body));
  assert.equal(registered.body.name, "Validation Supplier");
  assert.equal(registered.body.email, "sales@example.com");
  const id = registered.body.id;
  assert.equal((await call("post", "/suppliers", { name: "Validation Supplier", phone: "09171234567" })).status, 409);
  assert.equal((await call("post", "/suppliers", { id, name: "Validation Supplier", phone: "bad phone" })).status, 400);
  const listed = await call("get", "/suppliers");
  assert.equal(listed.body.find((entry) => entry.id === id).phone, "+63 917 845 2310");
  const edited = await call("post", "/suppliers", { id, name: "Validation Supplier", phone: "02 8863 5555" });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.phone, "02 8863 5555");
  await call("delete", `/suppliers/${id}`);
  const optional = await call("post", "/suppliers", { name: "Optional Contact Supplier" });
  assert.equal(optional.status, 201);
  await call("delete", `/suppliers/${optional.body.id}`);
});

test("suppliers archive and restore without losing details or changing inventory history", async () => {
  const registered = await call("post", "/suppliers", { name: "Archivable Supplier", phone: "09171234567", address: "Taguig", terms: "Net 30 Days" });
  assert.equal(registered.status, 201);
  const id = registered.body.id;
  const item = await create({ supplier: registered.body.name });
  const before = await Product.findById(item.id).lean();
  await Supplier.collection.insertOne({ name: "Legacy Active Supplier" });
  assert.ok((await call("get", "/suppliers")).body.some(entry => entry.name === "Legacy Active Supplier"));
  assert.equal((await call("delete", `/suppliers/${id}`, undefined, employeeToken)).status, 403);
  const archived = await call("delete", `/suppliers/${id}`, undefined, managerToken);
  assert.equal(archived.status, 200);
  assert.equal(archived.body.archived, true);
  assert.equal((await call("get", "/suppliers")).body.some(entry => entry.id === id), false);
  const archives = await call("get", "/suppliers", { archived: true });
  const saved = archives.body.find(entry => entry.id === id);
  assert.equal(saved.phone, "09171234567");
  assert.equal(saved.address, "Taguig");
  assert.equal((await call("post", "/suppliers", { name: "Archivable Supplier" })).status, 409);
  assert.equal((await call("post", "/suppliers", { id, name: "Changed Archive" })).status, 404);
  assert.equal((await call("post", `/suppliers/${id}/restore`, undefined, employeeToken)).status, 403);
  const restored = await call("post", `/suppliers/${id}/restore`, undefined, managerToken);
  assert.equal(restored.status, 200);
  assert.equal(restored.body.id, id);
  assert.equal(restored.body.archived, false);
  assert.equal(restored.body.phone, "09171234567");
  assert.ok((await call("get", "/suppliers")).body.some(entry => entry.id === id));
  assert.equal((await call("get", "/suppliers", { archived: true })).body.some(entry => entry.id === id), false);
  assert.deepEqual(await Product.findById(item.id).lean(), before);
  const missing = new mongoose.Types.ObjectId().toString();
  assert.equal((await call("delete", `/suppliers/${missing}`)).status, 404);
  assert.equal((await call("post", `/suppliers/${missing}/restore`)).status, 404);
  assert.equal((await call("get", "/suppliers", { archived: "invalid" })).status, 400);
});

test("technicians only see their own requests, including completed and deleted history", async () => {
  const item = await create();
  const own = await call("post", "/requests", { branchId, productId: item.id, quantityNeeded: 1 }, employeeToken);
  const other = await call("post", "/requests", { branchId, productId: item.id, quantityNeeded: 1 }, managerToken);
  await call("patch", `/requests/${own.body.id}`, { branchId, status: "APPROVED" });
  await call("patch", `/requests/${own.body.id}`, { branchId, status: "FULFILLED" });
  const employee = (await call("get", "/auth/me", {}, employeeToken)).body;
  const listed = await call("get", "/requests", { branchId }, employeeToken);
  assert.equal(listed.status, 200);
  assert.ok(listed.body.every(entry => entry.requestedBy === employee.id));
  assert.ok(listed.body.some(entry => entry.id === own.body.id && entry.status === "FULFILLED"));
  assert.ok(!listed.body.some(entry => entry.id === other.body.id));
  assert.equal(await Movement.countDocuments({ requestNumber: own.body.requestNumber }), 2);
  for (const token of [adminToken, managerToken]) {
    const entries = (await call("get", "/requests", { branchId }, token)).body;
    assert.ok(entries.some(entry => entry.id === own.body.id));
    assert.ok(entries.some(entry => entry.id === other.body.id));
  }
  await call("delete", `/requests/${other.body.id}`, { branchId });
  await call("delete", `/requests/${own.body.id}`, { branchId });
  const historical = (await call("get", "/requests", { branchId, includeDeleted: "true" }, employeeToken)).body;
  assert.ok(historical.every(entry => entry.requestedBy === employee.id));
  assert.ok(historical.some(entry => entry.id === own.body.id && entry.deletedAt));
  assert.ok(!historical.some(entry => entry.id === other.body.id));
});

test("technicians can delete only their own pending requests", async () => {
  const item = await create();
  const make = (token = employeeToken) => call("post", "/requests", { branchId, productId: item.id, quantityNeeded: 1 }, token);
  const other = await make(managerToken);
  assert.equal((await call("delete", `/requests/${other.body.id}`, { branchId }, employeeToken)).status, 403);
  assert.ok(!(await PartRequest.findById(other.body.id)).deletedAt);
  for (const status of ["PENDING", "APPROVED", "DENIED", "FULFILLED"]) {
    const own = await make();
    const path = `/requests/${own.body.id}`;
    if (["APPROVED", "FULFILLED"].includes(status)) await call("patch", path, { branchId, status: "APPROVED" });
    if (["DENIED", "FULFILLED"].includes(status)) await call("patch", path, { branchId, status, decisionReason: "Test denial" });
    const deleted = await call("delete", path, { branchId }, employeeToken);
    assert.equal(deleted.status, status === "PENDING" ? 200 : 403);
    assert.equal(Boolean((await PartRequest.findById(own.body.id)).deletedAt), status === "PENDING");
  }
  assert.equal((await Product.findById(item.id)).quantity, 4);
});

test("technician deletion racing approval cannot delete an approved request", async () => {
  const item = await create();
  const own = await call("post", "/requests", { branchId, productId: item.id, quantityNeeded: 1 }, employeeToken);
  const path = `/requests/${own.body.id}`;
  const [deleted, approved] = await Promise.all([
    call("delete", path, { branchId }, employeeToken),
    call("patch", path, { branchId, status: "APPROVED" }, managerToken),
  ]);
  const entry = await PartRequest.findById(own.body.id);
  if (approved.status === 200) {
    assert.equal(deleted.status, 403);
    assert.equal(entry.status, "APPROVED");
    assert.ok(!entry.deletedAt);
  } else {
    assert.equal(approved.status, 404);
    assert.equal(deleted.status, 200);
    assert.equal(entry.status, "PENDING");
    assert.ok(entry.deletedAt);
  }
});

test("managers can delete completed requests without changing stock, ledger or request identity", async () => {
  const item = await create();
  const created = await call("post", "/requests", { branchId, productId: item.id, quantityNeeded: 2 }, employeeToken);
  assert.equal(created.status, 201);
  const path = `/requests/${created.body.id}`;
  assert.equal((await call("patch", path, { branchId, status: "APPROVED" }, managerToken)).status, 200);
  assert.equal((await call("patch", path, { branchId, status: "FULFILLED" }, managerToken)).status, 200);
  assert.equal((await call("delete", path, { branchId }, employeeToken)).status, 403);
  const deleted = await call("delete", path, { branchId }, managerToken);
  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.requestNumber, created.body.requestNumber);
  assert.equal(deleted.body.history.at(-1).status, "DELETED");
  assert.equal(deleted.body.deletedByName, "Test Manager");
  assert.equal((await Product.findById(item.id)).quantity, 3);
  assert.equal(await Movement.countDocuments({ referenceId: created.body.id }), 2);
  assert.ok(!(await call("get", "/requests", { branchId })).body.some(entry => entry.id === created.body.id));
  const historical = (await call("get", "/requests", { branchId, includeDeleted: "true" })).body.find(entry => entry.id === created.body.id);
  assert.equal(historical.status, "FULFILLED");
  assert.deepEqual(historical.history.map(event => event.status), ["PENDING", "APPROVED", "FULFILLED", "DELETED"]);
  assert.equal((await call("patch", path, { branchId, status: "FULFILLED" })).status, 404);
  assert.equal((await call("delete", path, { branchId })).status, 404);
  assert.equal((await call("post", "/requests", { branchId, productId: item.id, quantityNeeded: 2, requestId: created.body.id }, employeeToken)).status, 409);
});

test("deleted active requests stop blocking inventory archiving", async () => {
  const item = await create({ quantity: 0 });
  const created = await call("post", "/requests", { branchId, productId: item.id, quantityNeeded: 1 }, employeeToken);
  const path = `/requests/${created.body.id}`;
  assert.equal((await call("patch", path, { branchId, status: "APPROVED" })).status, 200);
  assert.equal((await call("delete", `/products/${item.id}`, { branchId })).status, 409);
  assert.equal((await call("delete", path, { branchId })).status, 200);
  assert.equal((await call("delete", `/products/${item.id}`, { branchId })).status, 200);
  assert.ok(await PartRequest.exists({ _id: created.body.id }));
});

test("request deletion racing fulfillment cannot cause partial stock changes", async () => {
  const item = await create();
  const created = await call("post", "/requests", { branchId, productId: item.id, quantityNeeded: 2 }, employeeToken);
  const path = `/requests/${created.body.id}`;
  await call("patch", path, { branchId, status: "APPROVED" });
  const [deleted, fulfilled] = await Promise.all([
    call("delete", path, { branchId }), call("patch", path, { branchId, status: "FULFILLED" }),
  ]);
  assert.equal(deleted.status, 200);
  assert.ok([200, 404].includes(fulfilled.status));
  assert.equal((await Product.findById(item.id)).quantity, fulfilled.status === 200 ? 3 : 5);
  assert.equal(await Movement.countDocuments({ referenceId: created.body.id }), fulfilled.status === 200 ? 2 : 0);
  assert.equal((await Product.findOne({ branchId: serviceVanId, sku: item.sku }))?.quantity || 0, fulfilled.status === 200 ? 2 : 0);
  assert.ok((await PartRequest.findById(created.body.id)).deletedAt);
});

test("all roles can edit their profile without granting themselves a different role or email", async () => {
  for (const role of ["ADMIN", "MANAGER", "EMPLOYEE"]) {
    const user = await removalAccount(`profile-${role.toLowerCase()}`, role);
    const login = await http.post("/api/auth/login").send({ email: user.email, password: "Removal-test-2026" });
    const result = await call("patch", "/auth/me", { firstName: "Updated", lastName: "Profile", availability: "BUSY", role: "ADMIN", email: "forged@example.test" }, login.body.token);
    assert.equal(result.status, 200);
    assert.equal(result.body.fullName, "Updated Profile");
    assert.equal(result.body.availability, "BUSY");
    assert.equal(result.body.role, role);
    assert.equal(result.body.email, user.email);
    assert.equal(result.body.passwordHash, undefined);
  }
});

test("personal password changes require the current password and revoke other sessions", async () => {
  const user = await removalAccount("profile-password");
  const login = async () => (await http.post("/api/auth/login").send({ email: user.email, password: "Removal-test-2026" })).body.token;
  const token = await login(), otherToken = await login();
  const body = { firstName: "Profile", lastName: "Password", availability: "AWAY", password: "Changed-password-2026", currentPassword: "wrong" };
  assert.equal((await call("patch", "/auth/me", { ...body, currentPassword: "" }, token)).status, 400);
  assert.equal((await call("patch", "/auth/me", body, token)).status, 400);
  assert.equal((await call("patch", "/auth/me", { ...body, currentPassword: "Removal-test-2026" }, token)).status, 200);
  assert.equal((await call("get", "/auth/me", {}, token)).status, 200);
  assert.equal((await call("get", "/auth/me", {}, otherToken)).status, 401);
  assert.equal((await http.post("/api/auth/login").send({ email: user.email, password: "Removal-test-2026" })).status, 401);
  assert.equal((await http.post("/api/auth/login").send({ email: user.email, password: body.password })).status, 200);
});

test("admin account editing changes email, role and password and updates assigned driver names", async () => {
  const user = await removalAccount("profile-admin-edit");
  const login = await http.post("/api/auth/login").send({ email: user.email, password: "Removal-test-2026" });
  await ServiceVan.create({ _id: "VAN-PROFILE", name: "Profile Van", driverId: user.id, driverName: user.fullName });
  const body = { firstName: "Promoted", lastName: "Manager", email: "promoted@example.test", role: "MANAGER", availability: "AVAILABLE", password: "Admin-reset-2026" };
  assert.equal((await call("patch", `/users/${user.id}`, body, employeeToken)).status, 403);
  assert.equal((await call("patch", `/users/${user.id}`, body, managerToken)).status, 403);
  const edited = await call("patch", `/users/${user.id}`, body);
  assert.equal(edited.status, 200);
  assert.equal(edited.body.role, "MANAGER");
  assert.equal(edited.body.email, body.email);
  assert.equal(edited.body.passwordHash, undefined);
  assert.equal((await ServiceVan.findById("VAN-PROFILE")).driverName, "Promoted Manager");
  assert.equal((await call("get", "/auth/me", {}, login.body.token)).status, 401);
  assert.equal((await http.post("/api/auth/login").send({ email: body.email, password: body.password })).status, 200);
  assert.equal((await call("patch", `/users/${user.id}`, { ...body, role: "ADMIN", password: "" })).status, 200);
  assert.equal((await call("patch", `/users/${user.id}`, { ...body, role: "EMPLOYEE", password: "" })).status, 200);
  const administrator = (await call("get", "/auth/me")).body;
  assert.equal((await call("patch", `/users/${administrator.id}`, { ...body, email: administrator.email, role: "EMPLOYEE", password: "" })).status, 409);
  assert.equal((await call("patch", `/users/${user.id}`, { ...body, email: administrator.email, password: "" })).status, 409);
  assert.equal((await call("patch", `/users/${user.id}`, { ...body, availability: "INVALID", password: "" })).status, 400);
});

test("user removal is admin-only, protects the signed-in administrator, and permits backup admins", async () => {
  const account = await removalAccount("removal-backup", "ADMIN");
  assert.equal((await call("delete", `/users/${account.id}`, {}, managerToken)).status, 403);
  assert.equal((await call("delete", `/users/${account.id}`, {}, employeeToken)).status, 403);
  const administrator = await call("get", "/auth/me");
  const self = await call("delete", `/users/${administrator.body.id}`);
  assert.equal(self.status, 409);
  assert.match(self.body.error, /own signed-in account/);
  assert.ok(await User.exists({ _id: administrator.body.id }));
  assert.equal((await call("delete", `/users/${account.id}`)).status, 200);
  assert.equal((await call("delete", `/users/${account.id}`)).status, 404);
});

test("removed users lose all sessions and cannot log in while their history remains", async () => {
  const user = await removalAccount("removal-staff");
  const login = await http.post("/api/auth/login").send({ email: user.email, password: "Removal-test-2026" });
  assert.equal(login.status, 200);
  assert.equal((await call("get", "/auth/me", {}, login.body.token)).status, 200);
  const item = await create();
  const entry = await Movement.create({ branchId, productId: item.id, performedBy: user.id, performedByName: user.fullName, movementType: "DETAILS", quantityDelta: 0 });
  const request = await PartRequest.create({ branchId, productId: item.id, quantityNeeded: 1, workOrderId: "REMOVAL-HISTORY", requestedBy: user.id, requestedByName: user.fullName });
  assert.equal((await call("delete", `/users/${user.id}`)).status, 200);
  assert.equal(await User.exists({ _id: user.id }), null);
  assert.equal(await Session.countDocuments({ userId: user.id }), 0);
  assert.equal((await call("get", "/auth/me", {}, login.body.token)).status, 401);
  assert.equal((await http.post("/api/auth/login").send({ email: user.email, password: "Removal-test-2026" })).status, 401);
  assert.equal((await Movement.findById(entry._id)).performedByName, user.fullName);
  assert.equal((await PartRequest.findById(request._id)).requestedByName, user.fullName);
});

test("assigned users must be unassigned with No Driver before removal, including legacy assignments", async () => {
  const user = await removalAccount("removal-driver");
  await ServiceVan.create({ _id: "VAN-USER-REMOVE-ID", name: "Assigned By ID", driverId: user.id, driverName: user.fullName });
  await ServiceVan.create({ _id: "VAN-USER-REMOVE-NAME", name: "Assigned By Name", driverName: `${user.fullName} (EMPLOYEE)` });
  const blocked = await call("delete", `/users/${user.id}`);
  assert.equal(blocked.status, 409);
  assert.match(blocked.body.error, /No Driver/);
  assert.ok(await User.exists({ _id: user.id }));
  assert.equal((await call("patch", "/service-vans/VAN-USER-REMOVE-ID/driver", { driverId: "" })).status, 200);
  assert.equal((await call("delete", `/users/${user.id}`)).status, 409);
  assert.equal((await call("patch", "/service-vans/VAN-USER-REMOVE-NAME/driver", { driverId: "" })).status, 200);
  assert.equal((await call("delete", `/users/${user.id}`)).status, 200);
});

test("two administrators cannot remove each other simultaneously", async () => {
  const first = await removalAccount("removal-admin-first", "ADMIN");
  const second = await removalAccount("removal-admin-second", "ADMIN");
  const login = async (user) => (await http.post("/api/auth/login").send({ email: user.email, password: "Removal-test-2026" })).body.token;
  const firstToken = await login(first);
  const secondToken = await login(second);
  const results = await Promise.all([
    call("delete", `/users/${second.id}`, {}, firstToken),
    call("delete", `/users/${first.id}`, {}, secondToken),
  ]);
  assert.deepEqual(results.map((response) => response.status).sort(), [200, 401]);
  assert.equal(await User.countDocuments({ _id: { $in: [first.id, second.id] } }), 1);
  assert.ok(await User.exists({ email: "admin@example.test" }));
});

test("account removal and driver assignment cannot leave a deleted driver on a vehicle", async () => {
  const user = await removalAccount("removal-assignment-race");
  const id = "VAN-USER-REMOVE-RACE";
  await ServiceVan.create({ _id: id, name: "Driver Assignment Race" });
  const [removal, assignment] = await Promise.all([
    call("delete", `/users/${user.id}`),
    call("patch", `/service-vans/${id}/driver`, { driverId: user.id }),
  ]);
  const van = await ServiceVan.findById(id);
  if (await User.exists({ _id: user.id })) {
    assert.equal(removal.status, 409);
    assert.equal(assignment.status, 200);
    assert.equal(van.driverId, user.id);
  } else {
    assert.equal(removal.status, 200);
    assert.equal(assignment.status, 404);
    assert.equal(van.driverId, "");
  }
});

test("vehicle registration saves photo-supported types and rejects retired classifications", async () => {
  const types = ["Cargo Van", "Pickup", "SUV"];
  for (const [index, vehicleType] of types.entries()) {
    const result = await call("post", "/service-vans", { id: `VAN-TYPE-${index}`, name: `Type Test ${index}`, vehicleType });
    assert.equal(result.status, 201);
    assert.equal(result.body.vehicleType, vehicleType);
    assert.equal((await ServiceVan.findById(result.body.id)).vehicleType, vehicleType);
  }
  const invalid = await call("post", "/service-vans", { id: "VAN-TYPE-INVALID", name: "Invalid Type", vehicleType: "Sedan" });
  assert.equal(invalid.status, 400);
  assert.equal(await ServiceVan.exists({ _id: "VAN-TYPE-INVALID" }), null);
  for (const vehicleType of ["Cab Chassis", "Hatchback", "Micro SUV"]) {
    const rejected = await call("post", "/service-vans", { id: "VAN-TYPE-RETIRED", name: "Retired type", vehicleType });
    assert.equal(rejected.status, 400);
  }
  await ServiceVan.create({ _id: "VAN-TYPE-EXISTING", name: "Existing SUV", vehicleType: "Micro SUV" });
  assert.equal((await call("patch", "/service-vans/VAN-TYPE-EXISTING/status", { status: "MAINTENANCE" })).status, 200);
  const legacy = await call("post", "/service-vans", { id: "VAN-TYPE-LEGACY", name: "Legacy Payload" });
  assert.equal(legacy.status, 201);
  assert.equal(legacy.body.vehicleType, "");
  const list = await call("get", "/service-vans");
  assert.equal(list.body.find((van) => van.id === "VAN-TYPE-1").vehicleType, "Pickup");
});

test("vehicle edits persist metadata and unchanged drivers while rejected edits roll back every field", async () => {
  const [driver, other] = await User.insertMany(["primary", "other"].map(name => ({
    email: `vehicle-edit-${name}@example.test`, fullName: `Vehicle Edit ${name}`, role: "EMPLOYEE", branchId,
    passwordHash: "unused-test-hash",
  })));
  const id = "VAN-EDIT-ATOMIC";
  await ServiceVan.create({ _id: id, name: "Original vehicle", plateNumber: "OLD-001", status: "AVAILABLE", driverId: String(driver._id), driverName: driver.fullName });
  const changed = { name: "Renamed vehicle", plateNumber: "NEW-002", status: "ON_FIELD", driverId: String(driver._id) };
  assert.equal((await call("patch", `/service-vans/${id}`, changed, managerToken)).status, 200);
  let saved = await ServiceVan.findById(id);
  assert.equal(saved.name, changed.name); assert.equal(saved.plateNumber, changed.plateNumber); assert.equal(saved.status, "ON_FIELD");
  // Returning to base with the same driver must not call the prohibited driver-reassignment path.
  assert.equal((await call("patch", `/service-vans/${id}`, { ...changed, status: "AVAILABLE" }, managerToken)).status, 200);
  await ServiceVan.findByIdAndUpdate(id, { status: "ON_FIELD" });
  const rejected = await call("patch", `/service-vans/${id}`, { name: "Must not persist", plateNumber: "BAD-003", status: "AVAILABLE", driverId: String(other._id) });
  assert.equal(rejected.status, 409);
  saved = await ServiceVan.findById(id);
  assert.equal(saved.name, changed.name); assert.equal(saved.plateNumber, changed.plateNumber);
  assert.equal(saved.status, "ON_FIELD"); assert.equal(saved.driverId, String(driver._id));
  assert.equal((await call("patch", `/service-vans/${id}`, { name: "Forbidden" }, employeeToken)).status, 403);
  assert.equal((await call("patch", `/service-vans/${id}`, { name: "Bad status", status: "INVALID" })).status, 400);
  assert.equal((await ServiceVan.findById(id)).name, changed.name);
});

test("vehicle edit validates dispatch and unique assignments without partial metadata saves", async () => {
  const id = "VAN-EDIT-EMPTY";
  await ServiceVan.create({ _id: id, name: "Unassigned vehicle" });
  assert.equal((await call("patch", `/service-vans/${id}`, { name: "Must not persist", status: "ON_FIELD", driverId: "" })).status, 400);
  assert.equal((await ServiceVan.findById(id)).name, "Unassigned vehicle");
  const assigned = await User.findOne({ email: "vehicle-edit-primary@example.test" });
  assert.equal((await call("patch", `/service-vans/${id}`, { name: "Conflict", driverId: String(assigned._id) })).status, 409);
  assert.equal((await ServiceVan.findById(id)).name, "Unassigned vehicle");
  assert.equal((await call("patch", "/service-vans/LOCAL-WAREHOUSE", { name: "Warehouse edit" })).status, 400);
  assert.equal((await call("patch", "/service-vans/VAN-EDIT-MISSING", { name: "Missing" })).status, 404);
});

test("only administrators can delete idle, unassigned service vehicles", async () => {
  const id = "VAN-DELETE-IDLE";
  await ServiceVan.create({ _id: id, name: "Idle Vehicle" });
  assert.equal((await call("delete", `/service-vans/${id}`, {}, managerToken)).status, 403);
  assert.equal((await call("delete", `/service-vans/${id}`, {}, employeeToken)).status, 403);
  assert.ok(await ServiceVan.exists({ _id: id }));
  assert.equal((await call("delete", `/service-vans/${id}`)).status, 200);
  assert.equal(await ServiceVan.exists({ _id: id }), null);
  assert.equal((await call("delete", `/service-vans/${id}`)).status, 404);
  assert.equal((await call("delete", "/service-vans/LOCAL-WAREHOUSE")).status, 400);
});

test("vehicle deletion blocks assigned drivers and all busy statuses", async () => {
  const cases = [
    { _id: "VAN-DELETE-DRIVER", name: "Assigned", driverId: "assigned-user" },
    { _id: "VAN-DELETE-LEGACY", name: "Legacy Driver", driverName: "Legacy Technician" },
    ...["ON_FIELD", "ARRIVED", "MAINTENANCE"].map((status) => ({ _id: `VAN-DELETE-${status}`, name: status, status })),
  ];
  for (const vehicle of cases) {
    await ServiceVan.create(vehicle);
    const response = await call("delete", `/service-vans/${vehicle._id}`);
    assert.equal(response.status, 409);
    assert.match(response.body.error, /Vehicle is busy/);
    assert.ok(await ServiceVan.exists({ _id: vehicle._id }));
  }
  await ServiceVan.updateOne({ _id: "VAN-DELETE-LEGACY" }, { $set: { driverName: "" } });
  assert.equal((await call("delete", "/service-vans/VAN-DELETE-LEGACY")).status, 200);
});

test("No Driver clears both modern and legacy assignments so idle vehicles can be deleted", async () => {
  const manager = await User.findOne({ email: "manager@example.test" });
  const vehicles = [
    { _id: "VAN-NO-DRIVER-LEGACY", name: "Legacy Assigned", driverName: "Legacy Technician" },
    { _id: "VAN-NO-DRIVER-MODERN", name: "ID Assigned", driverId: String(manager._id), driverName: manager.fullName },
  ];
  for (const vehicle of vehicles) {
    await ServiceVan.create(vehicle);
    assert.equal((await call("delete", `/service-vans/${vehicle._id}`)).status, 409);
    assert.equal((await call("patch", `/service-vans/${vehicle._id}/driver`, { driverId: "" }, employeeToken)).status, 403);
    const unassigned = await call("patch", `/service-vans/${vehicle._id}/driver`, { driverId: "" }, managerToken);
    assert.equal(unassigned.status, 200);
    assert.equal(unassigned.body.driverId, "");
    assert.equal(unassigned.body.driverName, "");
    assert.equal((await call("delete", `/service-vans/${vehicle._id}`)).status, 200);
  }
  await ServiceVan.create({ _id: "VAN-NO-DRIVER-WORKING", name: "On Field", driverId: String(manager._id), driverName: manager.fullName, status: "ON_FIELD" });
  assert.equal((await call("patch", "/service-vans/VAN-NO-DRIVER-WORKING/driver", { driverId: "" })).status, 409);
  assert.equal((await call("delete", "/service-vans/VAN-NO-DRIVER-WORKING")).status, 409);
});

test("vehicle deletion requires empty stock and resolved requests and preserves historical records", async () => {
  const id = "VAN-DELETE-STOCK";
  await ServiceVan.create({ _id: id, name: "Stocked Vehicle" });
  const item = await create({ branchId: id, quantity: 2 });
  assert.equal((await call("delete", `/service-vans/${id}`)).status, 409);
  assert.equal((await Product.findById(item.id)).quantity, 2);
  await Product.updateOne({ _id: item.id }, { $set: { quantity: 0 } });
  const request = await PartRequest.create({ branchId: id, productId: item.id, quantityNeeded: 1, workOrderId: "DELETE-TEST" });
  assert.equal((await call("delete", `/service-vans/${id}`)).status, 409);
  await PartRequest.updateOne({ _id: request._id }, { $set: { status: "APPROVED" } });
  assert.equal((await call("delete", `/service-vans/${id}`)).status, 409);
  await PartRequest.updateOne({ _id: request._id }, { $set: { status: "DENIED" } });
  const ledgerCount = await Movement.countDocuments({ branchId: id });
  assert.equal((await call("delete", `/service-vans/${id}`)).status, 200);
  assert.ok(await Product.exists({ _id: item.id }));
  assert.ok(await PartRequest.exists({ _id: request._id }));
  assert.equal(await Movement.countDocuments({ branchId: id }), ledgerCount);
});

test("vehicle deletion cannot race a warehouse transfer into leaving orphaned stock", async () => {
  const id = "VAN-DELETE-RACE";
  await ServiceVan.create({ _id: id, name: "Race Vehicle" });
  const item = await create({ quantity: 5 });
  const [deletion, transfer] = await Promise.all([
    call("delete", `/service-vans/${id}`),
    call("post", "/transfers", { branchId, destinationId: id, productId: item.id, quantity: 2, reason: "Deletion race check" }),
  ]);
  const vanExists = Boolean(await ServiceVan.exists({ _id: id }));
  const loaded = await Product.findOne({ branchId: id, sku: item.sku });
  if (vanExists) {
    assert.equal(transfer.status, 201);
    assert.equal(deletion.status, 409);
    assert.equal(loaded.quantity, 2);
    assert.equal((await Product.findById(item.id)).quantity, 3);
  } else {
    assert.equal(deletion.status, 200);
    assert.equal(transfer.status, 404);
    assert.ok(!loaded || loaded.quantity === 0);
    assert.equal((await Product.findById(item.id)).quantity, 5);
  }
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
  for (const quantity of ["1e3", "0x10", "12abc", "Infinity"]) {
    assert.equal((await call("post", "/products", product({ quantity }))).status, 400);
  }
  for (const field of ["unitCost", "listPrice"]) {
    assert.equal((await call("post", "/products", product({ [field]: 12.345 }))).status, 400);
  }
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
  const numericItem = await create({ quantity: 1 });
  for (const delta of ["1e2", "0x10", "-1e2"]) assert.equal((await movement(numericItem, delta)).status, 400);
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
  assert.equal(response.body.destinationVanId, serviceVanId);
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
  const approvedStock = (await call("get", "/products", { branchId })).body.find(entry => entry.id === item.id);
  assert.equal(approvedStock.approvedRequestQuantity, 2);
  assert.equal(approvedStock.reservedQuantity, 0);
  assert.equal(approvedStock.availableQuantity, 5);
  const results = await Promise.all([
    call("patch", path, { branchId, status: "FULFILLED" }),
    call("patch", path, { branchId, status: "FULFILLED" }),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
  assert.equal((await Product.findById(item.id)).quantity, 3);
  assert.equal(
    await Movement.countDocuments({ referenceId: response.body.id }),
    2,
  );
  const received = await Product.findOne({ branchId: serviceVanId, sku: item.sku });
  assert.equal(received.quantity, 2);
  assert.equal(received.brand, item.brand);
  const vanLedger = await call("get", "/movements", { branchId: serviceVanId, search: reference.body.requestNumber }, employeeToken);
  assert.equal(vanLedger.body.total, 1);
  assert.equal(vanLedger.body.items[0].quantityDelta, 2);
  assert.match(vanLedger.body.items[0].transferNumber, /^TRI\d{4,}$/);
  assert.match(vanLedger.body.items[0].vehicleReceiptNumber, /^VAN\d{4,}$/);
  const receiptSearch = await call("get", "/movements", { branchId: serviceVanId, search: vanLedger.body.items[0].vehicleReceiptNumber }, employeeToken);
  assert.equal(receiptSearch.body.total, 1);
  assert.equal(receiptSearch.body.items[0].id, vanLedger.body.items[0].id);
  const list = await call("get", "/requests", { branchId }, employeeToken);
  const saved = list.body.find((entry) => entry.id === response.body.id);
  assert.equal(saved.requestNumber, reference.body.requestNumber);
  assert.deepEqual(saved.history.map((event) => event.status), ["PENDING", "APPROVED", "FULFILLED"]);
  assert.deepEqual(saved.history.map((event) => event.performedByName), ["Test Employee", "Test Manager", "Test Admin"]);
  const ledger = await call("get", "/movements", { branchId, search: reference.body.requestNumber });
  assert.equal(ledger.body.total, 2);
  assert.equal(ledger.body.items[0].referenceId, response.body.id);
  assert.equal(ledger.body.items[0].requestNumber, reference.body.requestNumber);
});

test("technicians need an assigned vehicle for request references and submissions", async () => {
  const tech = await removalAccount("request-no-vehicle");
  const login = await call("post", "/auth/login", { email: tech.email, password: "Removal-test-2026" });
  const item = await create();
  const before = await PartRequest.countDocuments();
  assert.equal((await call("get", "/requests/reference", {}, login.body.token)).status, 409);
  const submitted = await call("post", "/requests", { branchId, productId: item.id, quantityNeeded: 1, destinationVanId: serviceVanId }, login.body.token);
  assert.equal(submitted.status, 409);
  assert.equal(await PartRequest.countDocuments(), before);
  assert.equal((await Product.findById(item.id)).quantity, item.quantity);
});

test("fulfillment adds to existing van stock and rolls back catalog mismatches", async () => {
  const item = await create({ quantity: 5 });
  const target = await create({ branchId: serviceVanId, sku: item.sku, quantity: 3 });
  const first = await call("post", "/requests", { branchId, productId: item.id, quantityNeeded: 2 }, employeeToken);
  await call("patch", `/requests/${first.body.id}`, { branchId, status: "APPROVED" });
  assert.equal((await call("patch", `/requests/${first.body.id}`, { branchId, status: "FULFILLED" })).status, 200);
  assert.equal((await Product.findById(target.id)).quantity, 5);
  const second = await call("post", "/requests", { branchId, productId: item.id, quantityNeeded: 1 }, employeeToken);
  await call("patch", `/requests/${second.body.id}`, { branchId, status: "APPROVED" });
  await Product.updateOne({ _id: target.id }, { $set: { archived: true } });
  assert.equal((await call("patch", `/requests/${second.body.id}`, { branchId, status: "FULFILLED" })).status, 409);
  assert.equal((await Product.findById(item.id)).quantity, 3);
  assert.equal((await Product.findById(target.id)).quantity, 5);
  assert.equal((await PartRequest.findById(second.body.id)).status, "APPROVED");
  assert.equal(await Movement.countDocuments({ referenceId: second.body.id }), 0);
});

test("fulfillment rejects changed vehicle assignments and supports pending legacy requests", async () => {
  const item = await create();
  const created = await call("post", "/requests", { branchId, productId: item.id, quantityNeeded: 1 }, employeeToken);
  await call("patch", `/requests/${created.body.id}`, { branchId, status: "APPROVED" });
  const van = await ServiceVan.findById(serviceVanId);
  await ServiceVan.updateOne({ _id: serviceVanId }, { $set: { driverId: "", driverName: "" } });
  try {
    assert.equal((await call("patch", `/requests/${created.body.id}`, { branchId, status: "FULFILLED" })).status, 409);
    assert.equal((await PartRequest.findById(created.body.id)).status, "APPROVED");
    assert.equal((await Product.findById(item.id)).quantity, item.quantity);
    assert.equal(await Movement.countDocuments({ referenceId: created.body.id }), 0);
    assert.equal((await call("delete", `/service-vans/${serviceVanId}`)).status, 409);
  } finally {
    await ServiceVan.updateOne({ _id: serviceVanId }, { $set: { driverId: van.driverId, driverName: van.driverName } });
  }
  await PartRequest.updateOne({ _id: created.body.id }, { $unset: { destinationVanId: "", destinationVanName: "" } });
  const fulfilled = await call("patch", `/requests/${created.body.id}`, { branchId, status: "FULFILLED" });
  assert.equal(fulfilled.status, 200, JSON.stringify(fulfilled.body));
  assert.equal(fulfilled.body.destinationVanId, serviceVanId);
  assert.equal((await Product.findOne({ branchId: serviceVanId, sku: item.sku })).quantity, 1);
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
  const outgoing = records.find((entry) => entry.movementType === "TRANSFER_OUT");
  const incoming = records.find((entry) => entry.movementType === "TRANSFER_IN");
  assert.match(outgoing.transferNumber, /^TRO\d{4,}$/);
  assert.match(incoming.transferNumber, /^TRI\d{4,}$/);
  for (const entry of records) {
    const found = await call("get", "/movements", { branchId, search: entry.transferNumber });
    assert.equal(found.body.total, 1);
    assert.equal(found.body.items[0].transferNumber, entry.transferNumber);
  }
  assert.equal(
    records.reduce((sum, entry) => sum + entry.quantityDelta, 0),
    0,
  );
});

test("vehicle returns identify both ledger entries independently of the entered reason", async () => {
  const item = await create({ quantity: 3 });
  const load = await call("post", "/transfers", { branchId, productId: item.id, destinationId: serviceVanId, quantity: 2, reason: "Loadout" });
  assert.equal(load.status, 201);
  const vanItem = await Product.findOne({ branchId: serviceVanId, sku: item.sku });
  const returned = await call("post", "/transfers", { branchId: serviceVanId, productId: String(vanItem._id), destinationId: branchId, quantity: 1, reason: "Unused materials returned" }, managerToken);
  assert.equal(returned.status, 201, JSON.stringify(returned.body));
  const pair = await Movement.find({ referenceId: returned.body.referenceId }).lean();
  assert.equal(pair.length, 2);
  assert.ok(pair.every((entry) => entry.isVehicleReturn === true));
  assert.equal(pair.reduce((sum, entry) => sum + entry.quantityDelta, 0), 0);
  const found = await call("get", "/movements", { branchId, type: "RETURNED", search: item.sku });
  assert.equal(found.body.total, 2);
  assert.ok(found.body.items.every((entry) => entry.referenceId === returned.body.referenceId));
  const legacy = await Movement.create({ branchId, movementType: "TRANSFER_IN", reason: "Emergency: Van Return to Warehouse LOCAL-WAREHOUSE", quantityDelta: 1, sku: item.sku });
  const old = await call("get", "/movements", { branchId, type: "RETURNED", search: item.sku });
  assert.equal(old.body.total, 3);
  assert.ok(old.body.items.some((entry) => entry.id === String(legacy._id)));
});

test("concurrent transfers have unique directional numbers and separate shared links", async () => {
  const products = await Promise.all(Array.from({ length: 4 }, () => create({ quantity: 2 })));
  const transfers = await Promise.all(products.map((item) => call("post", "/transfers", {
    branchId, destinationId: serviceVanId, productId: item.id, quantity: 1, reason: "Numbering concurrency check",
  })));
  for (const response of transfers) assert.equal(response.status, 201, JSON.stringify(response.body));
  const references = transfers.map((response) => response.body.referenceId);
  assert.equal(new Set(references).size, 4);
  const records = await Movement.find({ referenceId: { $in: references } }).lean();
  assert.equal(records.length, 8);
  assert.equal(new Set(records.map((entry) => entry.transferNumber)).size, 8);
  for (const referenceId of references) {
    const pair = records.filter((entry) => entry.referenceId === referenceId);
    assert.equal(pair.length, 2);
    assert.match(pair.find((entry) => entry.movementType === "TRANSFER_IN").transferNumber, /^TRI\d{4,}$/);
    assert.match(pair.find((entry) => entry.movementType === "TRANSFER_OUT").transferNumber, /^TRO\d{4,}$/);
  }
});

test("existing transfer numbering is repeatable and preserves references and stock history", async () => {
  const createdAt = new Date("2025-01-01T00:00:00Z");
  const entries = await Movement.create([
    { branchId, movementType: "TRANSFER_OUT", quantityDelta: -1, beforeQuantity: 3, afterQuantity: 2, referenceId: "TRA-LEGACY", createdAt },
    { branchId: serviceVanId, movementType: "TRANSFER_IN", quantityDelta: 1, beforeQuantity: 0, afterQuantity: 1, referenceId: "TRA-LEGACY", createdAt },
  ]);
  await assignExistingTransferNumbers();
  const first = await Movement.find({ _id: { $in: entries.map((entry) => entry._id) } }).sort({ movementType: 1 }).lean();
  assert.match(first[0].transferNumber, /^TRI\d{4,}$/);
  assert.match(first[1].transferNumber, /^TRO\d{4,}$/);
  for (const entry of first) {
    assert.equal(entry.referenceId, "TRA-LEGACY");
    assert.equal(entry.createdAt.toISOString(), createdAt.toISOString());
    assert.equal(entry.afterQuantity - entry.beforeQuantity, entry.quantityDelta);
  }
  await assignExistingTransferNumbers();
  const second = await Movement.find({ _id: { $in: entries.map((entry) => entry._id) } }).sort({ movementType: 1 }).lean();
  assert.deepEqual(second, first);
});

test("legacy request receipts gain repeatable VAN numbers without changing history", async () => {
  const legacy = await Movement.create({ branchId: serviceVanId, movementType: "TRANSFER_IN", requestNumber: "REQ9999", transferNumber: "TRI9999", referenceId: "original-request-id", quantityDelta: 2, beforeQuantity: 1, afterQuantity: 3 });
  const before = legacy.toObject();
  await assignExistingTransferNumbers();
  const first = await Movement.findById(legacy._id).lean();
  assert.match(first.vehicleReceiptNumber, /^VAN\d{4,}$/);
  const { vehicleReceiptNumber, ...preserved } = first;
  assert.deepEqual(preserved, before);
  await assignExistingTransferNumbers();
  assert.deepEqual(await Movement.findById(legacy._id).lean(), first);
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
  const job = await createJob();
  const ticket = await call("post", `/service-vans/${serviceVanId}/usage-ticket`, {}, employeeToken);
  assert.equal(ticket.status, 201);
  assert.match(ticket.body.usageId, /^USE\d{4,}$/);
  const response = await call(
    "post",
    `/service-vans/${serviceVanId}/consume`,
    {
      productId: item.id,
      quantity: 2,
      usageId: ticket.body.usageId, jobOrderId: job.id,
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
  assert.equal(movement.workOrderId, job.jobNumber);
  assert.equal(String(movement.jobOrderId), job.id);
  assert.equal(movement.referenceId, ticket.body.usageId);
  assert.equal(movement.quantityDelta, -2);
  const ledger = await call(
    "get",
    "/movements",
    { branchId, search: ticket.body.usageId },
    employeeToken,
  );
  assert.equal(ledger.status, 200);
  assert.equal(ledger.body.total, 1);
  const duplicate = await call("post", `/service-vans/${serviceVanId}/consume`, {
    productId: item.id, quantity: 1, usageId: ticket.body.usageId, jobOrderId: job.id, notes: "Duplicate attempt",
  }, employeeToken);
  assert.equal(duplicate.status, 409);
  assert.equal((await Product.findById(item.id)).quantity, 3);
});

test("generated usage IDs respect ownership and survive failed stock deductions", async () => {
  const item = await create({ branchId: serviceVanId, quantity: 2 });
  const job = await createJob();
  const reserved = await Promise.all(Array.from({ length: 5 }, () =>
    call("post", `/service-vans/${serviceVanId}/usage-ticket`, {}, employeeToken)));
  assert.ok(reserved.every((response) => response.status === 201));
  assert.equal(new Set(reserved.map((response) => response.body.usageId)).size, 5);
  const payload = { productId: item.id, quantity: 3, usageId: reserved[0].body.usageId, jobOrderId: job.id, notes: "Site repair" };
  assert.equal((await call("post", `/service-vans/${serviceVanId}/consume`, payload, adminToken)).status, 403);
  assert.equal((await call("post", `/service-vans/${serviceVanId}/consume`, payload, employeeToken)).status, 409);
  const retry = await call("post", `/service-vans/${serviceVanId}/consume`, { ...payload, quantity: 1 }, employeeToken);
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  const invalid = await call("post", `/service-vans/${serviceVanId}/consume`, {
    ...payload, usageId: "JOB-2026-001", quantity: 1,
  }, employeeToken);
  assert.equal(invalid.status, 400);
  await ServiceVan.create({ _id: "VAN-JOB-SCOPE", name: "Other vehicle" });
  assert.equal((await call("post", "/service-vans/VAN-JOB-SCOPE/usage-ticket", {}, employeeToken)).status, 403);
  const foreign = await call("post", "/service-vans/VAN-JOB-SCOPE/consume", {
    ...payload, usageId: reserved[1].body.usageId, quantity: 1,
  }, adminToken);
  assert.equal(foreign.status, 400);
});

test("distinct usage IDs link to one assigned job and appear in its materials history", async () => {
  const vanItem = await create({ branchId: serviceVanId, quantity: 5 });
  const job = await createJob();
  for (let index = 0; index < 3; index += 1) {
    const ticket = await call("post", `/service-vans/${serviceVanId}/usage-ticket`, {}, employeeToken);
    const response = await call("post", `/service-vans/${serviceVanId}/consume`, {
      productId: vanItem.id, quantity: 1, usageId: ticket.body.usageId,
      jobOrderId: job.id, notes: "Materials used on site",
    }, employeeToken);
    assert.equal(response.status, 200, JSON.stringify(response.body));
  }
  const linked = await Movement.find({ jobOrderId: job.id });
  assert.equal(linked.length, 3);
  assert.equal(new Set(linked.map((entry) => entry.referenceId)).size, 3);
  assert.ok(linked.every((entry) => entry.workOrderId === job.jobNumber));
  const details = await call("get", `/job-orders/${job.id}`, {}, employeeToken);
  assert.equal(details.status, 200);
  assert.equal(details.body.movements.length, 3);
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

test("warehouse chart movements exclude vehicle receipts from direct loadouts and fulfilled requests", async () => {
  const item = await create({ quantity: 3 });
  const transfer = await call("post", "/transfers", {
    branchId, productId: item.id, destinationId: serviceVanId, quantity: 1, reason: "Chart regression loadout", isVanTransfer: true,
  });
  assert.equal(transfer.status, 201, JSON.stringify(transfer.body));
  const reference = await call("get", "/requests/reference", {}, employeeToken);
  const request = await call("post", "/requests", {
    branchId, productId: item.id, quantityNeeded: 2, requestId: reference.body.id,
  }, employeeToken);
  assert.equal(request.status, 201, JSON.stringify(request.body));
  assert.equal((await call("patch", `/requests/${request.body.id}`, { branchId, status: "APPROVED" })).status, 200);
  assert.equal((await call("patch", `/requests/${request.body.id}`, { branchId, status: "FULFILLED" })).status, 200);
  assert.equal((await Product.findById(item.id)).quantity, 0);
  assert.equal((await Product.findOne({ sku: item.sku, branchId: serviceVanId })).quantity, 3);

  const ledger = await call("get", "/movements", { branchId, search: item.sku, pageSize: 100 });
  assert.equal(ledger.body.total, 5);
  const first = await call("get", "/movements", { branchId, scope: "branch", search: item.sku, pageSize: 2 });
  const second = await call("get", "/movements", { branchId, scope: "branch", search: item.sku, pageSize: 2, page: 2 });
  const movements = [...first.body.items, ...second.body.items];
  assert.equal(first.body.total, 3);
  assert.equal(second.body.total, 3);
  assert.equal(movements.length, 3);
  assert.ok(movements.every((entry) => entry.branchId === branchId));
  assert.equal(movements.reduce((sum, entry) => sum + Math.max(0, entry.quantityDelta), 0), 3);
  assert.equal(movements.reduce((sum, entry) => sum + Math.min(0, entry.quantityDelta), 0), -3);
  assert.equal(movements.reduce((sum, entry) => sum + entry.quantityDelta, 0), 0);
  const vehicle = await call("get", "/movements", { branchId: serviceVanId, scope: "branch", search: item.sku }, employeeToken);
  assert.equal(vehicle.body.total, 2);
  assert.equal((await call("get", "/movements", { branchId, scope: "invalid" })).status, 400);
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

test("job orders are generated by managers, scoped to technicians, and reject closed or foreign usage", async () => {
  const own = await createJob();
  assert.match(own.jobNumber, /^JOB\d{4,}$/);
  assert.equal((await call('post', '/job-orders', {}, employeeToken)).status, 403);
  const other = await removalAccount('job-other-tech');
  await ServiceVan.create({ _id: 'VAN-JOB-OTHER', name: 'Other job van', driverId: other.id, driverName: other.fullName });
  const foreign = await createJob({ vanId: 'VAN-JOB-OTHER', assignedTechnicianId: other.id });
  const listed = await call('get', '/job-orders', {}, employeeToken);
  assert.ok(listed.body.some(job => job.id === own.id));
  assert.ok(!listed.body.some(job => job.id === foreign.id));
  assert.equal((await call('get', `/job-orders/${foreign.id}`, {}, employeeToken)).status, 404);
  assert.equal((await call('patch', `/job-orders/${foreign.id}/status`, { status: 'COMPLETED' }, employeeToken)).status, 409);
  assert.equal((await call('patch', `/job-orders/${own.id}/status`, { status: 'CANCELLED' }, employeeToken)).status, 403);
  const item = await create({ branchId: serviceVanId, quantity: 2 });
  const ticket = await call('post', `/service-vans/${serviceVanId}/usage-ticket`, {}, employeeToken);
  const payload = { productId: item.id, quantity: 1, usageId: ticket.body.usageId, notes: 'Site repair' };
  assert.equal((await call('post', `/service-vans/${serviceVanId}/consume`, payload, employeeToken)).status, 400);
  assert.equal((await call('post', `/service-vans/${serviceVanId}/consume`, { ...payload, jobOrderId: foreign.id }, employeeToken)).status, 409);
  assert.equal((await call('patch', `/job-orders/${own.id}/status`, { status: 'COMPLETED' }, employeeToken)).status, 200);
  assert.equal((await call('post', `/service-vans/${serviceVanId}/consume`, { ...payload, jobOrderId: own.id }, employeeToken)).status, 409);
  assert.equal((await Product.findById(item.id)).quantity, 2);
  const cancelled = await createJob();
  assert.equal((await call('patch', `/job-orders/${cancelled.id}/status`, { status: 'CANCELLED' })).status, 200);
  assert.equal((await call('post', `/service-vans/${serviceVanId}/consume`, { ...payload, jobOrderId: cancelled.id }, employeeToken)).status, 409);
});

test("parallel job creation generates unique numbers and enforces the selected vehicle assignment", async () => {
  const jobs = await Promise.all(Array.from({ length: 4 }, () => createJob({}, managerToken, false)));
  assert.equal(new Set(jobs.map(job => job.jobNumber)).size, 4);
  const manager = await User.findOne({ email: 'manager@example.test' });
  const invalidTechnician = await call('post', '/job-orders', {
    title: 'Invalid assignment', customerName: 'Customer', location: 'Taguig', vanId: serviceVanId, assignedTechnicianId: String(manager._id),
  });
  assert.equal(invalidTechnician.status, 400);
  const other = await User.findOne({ email: 'job-other-tech@example.test' });
  const mismatched = await call('post', '/job-orders', {
    title: 'Invalid vehicle', customerName: 'Customer', location: 'Taguig', vanId: serviceVanId, assignedTechnicianId: String(other._id),
  });
  assert.equal(mismatched.status, 409);
});

test("completion racing usage cannot record materials after a job is closed", async () => {
  const job = await createJob();
  const item = await create({ branchId: serviceVanId, quantity: 2 });
  const ticket = await call('post', `/service-vans/${serviceVanId}/usage-ticket`, {}, employeeToken);
  const [usage, completion] = await Promise.all([
    call('post', `/service-vans/${serviceVanId}/consume`, { productId: item.id, quantity: 1, usageId: ticket.body.usageId, jobOrderId: job.id, notes: 'Final material' }, employeeToken),
    call('patch', `/job-orders/${job.id}/status`, { status: 'COMPLETED' }, managerToken),
  ]);
  assert.equal(completion.status, 200);
  assert.ok([200, 409].includes(usage.status));
  const quantity = (await Product.findById(item.id)).quantity;
  assert.equal(quantity, usage.status === 200 ? 1 : 2);
  assert.equal(await Movement.countDocuments({ jobOrderId: job.id }), usage.status === 200 ? 1 : 0);
});

test("open job assignments block deleting accounts and vehicles while closed jobs retain their history", async () => {
  const tech = await removalAccount('job-delete-tech');
  tech.fullName = "Job Deletion Technician";
  await User.updateOne({ _id: tech.id }, { $set: { fullName: tech.fullName } });
  await ServiceVan.create({ _id: 'VAN-JOB-DELETE', name: 'Job deletion van', driverId: tech.id, driverName: tech.fullName });
  const job = await createJob({ vanId: 'VAN-JOB-DELETE', assignedTechnicianId: tech.id });
  await ServiceVan.updateOne({ _id: 'VAN-JOB-DELETE' }, { $set: { driverId: '', driverName: '' } });
  assert.equal((await call('delete', `/users/${tech.id}`)).status, 409);
  assert.equal((await call('delete', '/service-vans/VAN-JOB-DELETE')).status, 409);
  assert.equal((await call('patch', `/job-orders/${job.id}/status`, { status: 'CANCELLED' })).status, 200);
  assert.equal((await call('delete', `/users/${tech.id}`)).status, 200);
  assert.equal((await call('delete', '/service-vans/VAN-JOB-DELETE')).status, 200);
  const history = await call('get', `/job-orders/${job.id}`);
  assert.equal(history.status, 200);
  assert.equal(history.body.technicianName, tech.fullName);
});

test("managers control the current job and technicians cannot record against queued work", async () => {
  const current = await createJob();
  const queued = await createJob({}, managerToken, false);
  assert.equal(queued.isCurrent, false);
  assert.equal((await call("patch", `/job-orders/${queued.id}/assignment`, {}, employeeToken)).status, 403);
  const assigned = await call("get", "/job-orders", { vanId: serviceVanId, status: "OPEN", current: "true" }, employeeToken);
  assert.deepEqual(assigned.body.map((job) => job.id), [current.id]);
  const item = await create({ branchId: serviceVanId, quantity: 3 });
  const ticket = await call("post", `/service-vans/${serviceVanId}/usage-ticket`, {}, employeeToken);
  const payload = { productId: item.id, quantity: 1, usageId: ticket.body.usageId, notes: "Current service work" };
  assert.equal((await call("post", `/service-vans/${serviceVanId}/consume`, { ...payload, jobOrderId: queued.id }, employeeToken)).status, 409);
  assert.equal((await call("patch", `/job-orders/${queued.id}/assignment`, {}, managerToken)).status, 200);
  assert.equal((await call("post", `/service-vans/${serviceVanId}/consume`, { ...payload, jobOrderId: current.id }, employeeToken)).status, 409);
  assert.equal((await call("post", `/service-vans/${serviceVanId}/consume`, { ...payload, jobOrderId: queued.id }, employeeToken)).status, 200);
  assert.equal((await JobOrder.findById(current.id)).isCurrent, false);
  assert.equal((await JobOrder.findById(current.id)).status, "OPEN");
  assert.equal((await call("patch", `/job-orders/${queued.id}/status`, { status: "COMPLETED" }, employeeToken)).status, 200);
  const remaining = await call("get", "/job-orders", { current: "true" }, employeeToken);
  assert.equal(remaining.body.length, 0);
  assert.equal((await Product.findById(item.id)).quantity, 2);
});

test("simultaneous manager assignments leave exactly one current job", async () => {
  const jobs = await Promise.all([createJob({}, managerToken, false), createJob({}, managerToken, false)]);
  const results = await Promise.all(jobs.map((job) => call("patch", `/job-orders/${job.id}/assignment`, {}, managerToken)));
  assert.ok(results.every((result) => result.status === 200), JSON.stringify(results.map((result) => result.body)));
  const current = await JobOrder.find({ isCurrent: true, vanId: serviceVanId });
  assert.equal(current.length, 1);
  assert.ok(jobs.some((job) => job.id === String(current[0]._id)));
});

test("switching the current job during usage preserves stock and job linkage", async () => {
  const original = await createJob();
  const next = await createJob({}, managerToken, false);
  const item = await create({ branchId: serviceVanId, quantity: 2 });
  const ticket = await call("post", `/service-vans/${serviceVanId}/usage-ticket`, {}, employeeToken);
  const [usage, assignment] = await Promise.all([
    call("post", `/service-vans/${serviceVanId}/consume`, { productId: item.id, quantity: 1, usageId: ticket.body.usageId, jobOrderId: original.id, notes: "Work in progress" }, employeeToken),
    call("patch", `/job-orders/${next.id}/assignment`, {}, managerToken),
  ]);
  assert.equal(assignment.status, 200);
  assert.ok([200, 409].includes(usage.status));
  assert.equal((await Product.findById(item.id)).quantity, usage.status === 200 ? 1 : 2);
  assert.equal(await Movement.countDocuments({ jobOrderId: original.id }), usage.status === 200 ? 1 : 0);
  assert.equal((await JobOrder.findById(next.id)).isCurrent, true);
});

test("managers and admins can edit and reassign open jobs while preserving material history", async () => {
  const other = await User.findOne({ email: "job-other-tech@example.test" });
  const target = { assignedTechnicianId: String(other._id), vanId: "VAN-JOB-OTHER" };
  const recipientCurrent = await createJob(target);
  const original = await createJob();
  const item = await create({ branchId: serviceVanId, quantity: 3 });
  const ticket = await call("post", `/service-vans/${serviceVanId}/usage-ticket`, {}, employeeToken);
  const usage = { productId: item.id, quantity: 1, usageId: ticket.body.usageId, jobOrderId: original.id, notes: "Before reassignment" };
  assert.equal((await call("post", `/service-vans/${serviceVanId}/consume`, usage, employeeToken)).status, 200);
  const before = (await Movement.findOne({ jobOrderId: original.id })).toObject();
  const payload = { ...original, ...target, title: "Updated service job" };
  assert.equal((await call("patch", `/job-orders/${original.id}`, payload, employeeToken)).status, 403);
  assert.equal((await call("patch", `/job-orders/${original.id}`, { ...payload, vanId: serviceVanId }, managerToken)).status, 409);
  const edited = await call("patch", `/job-orders/${original.id}`, payload, managerToken);
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.equal(edited.body.jobNumber, original.jobNumber);
  assert.equal(edited.body.title, payload.title);
  assert.equal(edited.body.assignedTechnicianId, target.assignedTechnicianId);
  assert.equal(edited.body.isCurrent, true);
  assert.equal((await JobOrder.findById(recipientCurrent.id)).isCurrent, false);
  assert.equal((await call("get", `/job-orders/${original.id}`, {}, employeeToken)).status, 404);
  assert.equal((await call("post", `/service-vans/${serviceVanId}/consume`, { ...usage, usageId: undefined }, employeeToken)).status, 409);
  assert.deepEqual((await Movement.findOne({ jobOrderId: original.id })).toObject(), before);
  assert.equal((await Product.findById(item.id)).quantity, 2);

  const queued = await createJob({}, managerToken, false);
  const queuedEdit = await call("patch", `/job-orders/${queued.id}`, { ...queued, ...target }, adminToken);
  assert.equal(queuedEdit.status, 200, JSON.stringify(queuedEdit.body));
  assert.equal(queuedEdit.body.isCurrent, false);
  assert.equal((await JobOrder.findById(original.id)).isCurrent, true);
  assert.equal((await call("patch", `/job-orders/${queued.id}/status`, { status: "CANCELLED" })).status, 200);
  assert.equal((await call("patch", `/job-orders/${queued.id}`, { ...queued, ...target })).status, 409);
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
  for (const password of ["lowercase12345", "UPPERCASE12345", "MissingNumbers", "Weak-password-2026 "]) {
    assert.equal((await call("post", "/users", { email: "weak@example.test", password, fullName: "Weak Password", role: "EMPLOYEE", branchId })).status, 400);
  }
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
