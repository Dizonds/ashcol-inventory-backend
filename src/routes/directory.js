import { Router } from "express";
import { ServiceVan, Brand, User, Supplier } from "../models.js";
import { admin, manage, hashPassword } from "../auth.js";
import { text, fail, json } from "../helpers.js";

const router = Router();
router.get("/service-vans", (req, res, next) => {
  ServiceVan.find()
    .sort({ name: 1 })
    .then((items) => res.json(items.map(json)))
    .catch(next);
});
router.post("/service-vans", admin, (req, res, next) => {
  const id = text(req.body.id, "Vehicle ID");
  if (!/^[A-Za-z0-9-]+$/.test(id))
    fail("Use letters, numbers and hyphens for vehicle IDs.");
  const plateNumber = text(req.body.plateNumber || "", "Plate number", false);
  const driverName = text(req.body.driverName || "", "Driver / Technician", false);
  const status = ["AVAILABLE", "ON_FIELD", "ARRIVED", "MAINTENANCE"].includes(
    req.body.status,
  )
    ? req.body.status
    : "AVAILABLE";
  ServiceVan.create({
    _id: id,
    name: text(req.body.name, "Vehicle name"),
    plateNumber,
    driverName,
    status,
  })
    .then((item) => res.status(201).json(json(item)))
    .catch(next);
});
// Technicians/drivers, managers and admins can update van status (e.g. arrived, on field, available)
router.patch("/service-vans/:id/status", (req, res, next) => {
  const status = text(req.body.status, "Status");
  if (!["AVAILABLE", "ON_FIELD", "ARRIVED", "MAINTENANCE"].includes(status))
    fail("Invalid status.");
  ServiceVan.findById(req.params.id)
    .then((van) => {
      if (!van) fail("Service vehicle not found.", 404);
      if (
        ["ON_FIELD", "ARRIVED"].includes(status) &&
        !van.driverName
      ) {
        fail(
          "An assigned technician/driver is required before dispatching or marking the van as arrived on field.",
          400,
        );
      }
      van.status = status;
      return van.save();
    })
    .then((item) => {
      res.json(json(item));
    })
    .catch(next);
});
// Assign driver / technician to a van (Managers & Admins)
router.patch("/service-vans/:id/driver", manage, (req, res, next) => {
  const driverName = text(req.body.driverName || "", "Driver name", false);
  ServiceVan.findByIdAndUpdate(
    req.params.id,
    { $set: { driverName } },
    { new: true },
  )
    .then((item) => {
      if (!item) fail("Service vehicle not found.", 404);
      res.json(json(item));
    })
    .catch(next);
});
router.get("/brands", (req, res, next) => {
  Brand.find()
    .sort({ name: 1 })
    .then((items) => res.json(items.map(json)))
    .catch(next);
});
router.post("/brands", manage, (req, res, next) => {
  const name = text(req.body.name, "Brand");
  Brand.findOne({ name })
    .collation({ locale: "en", strength: 2 })
    .then((found) => found || Brand.create({ name }))
    .then((item) => res.status(201).json(json(item)))
    .catch(next);
});
router.get("/suppliers", (req, res, next) => {
  Supplier.find()
    .sort({ name: 1 })
    .then((items) => res.json(items.map(json)))
    .catch(next);
});
router.post("/suppliers", manage, (req, res, next) => {
  const name = text(req.body.name, "Supplier name");
  Supplier.findOneAndUpdate(
    { name },
    {
      $set: {
        name,
        contactPerson: text(req.body.contactPerson || "", "Contact person", false),
        phone: text(req.body.phone || "", "Phone", false),
        email: text(req.body.email || "", "Email", false),
        address: text(req.body.address || "", "Address", false),
        terms: text(req.body.terms || "", "Terms", false),
      },
    },
    { upsert: true, new: true },
  )
    .then((item) => res.status(201).json(json(item)))
    .catch(next);
});
router.get("/users", manage, (req, res, next) => {
  User.find()
    .sort({ fullName: 1 })
    .then((items) => res.json(items.map(json)))
    .catch(next);
});
router.post("/users", admin, (req, res, next) => {
  const email = text(req.body.email, "Email").toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail("Enter a valid email.");
  let firstName = typeof req.body.firstName === "string" ? text(req.body.firstName, "First name") : "";
  let lastName = typeof req.body.lastName === "string" ? text(req.body.lastName, "Last name") : "";
  // Accept the old fullName payload so existing clients can continue to create accounts.
  if (!firstName || !lastName) {
    const legacyName = text(req.body.fullName, "Full name");
    const parts = legacyName.split(/\s+/);
    firstName = parts.shift() || "";
    lastName = parts.join(" ");
  }
  if (!/^[\p{L}][\p{L} .'-]{1,49}$/u.test(firstName))
    fail("First name must contain 2-50 letters and valid name characters.");
  if (!/^[\p{L}][\p{L} .'-]{1,49}$/u.test(lastName))
    fail("Last name must contain 2-50 letters and valid name characters.");
  const fullName = `${firstName} ${lastName}`;
  text(req.body.password, "Password");
  const password = req.body.password;
  if (password.length < 10) fail("Use at least 10 characters for passwords.");
  const role = text(req.body.role, "Role");
  if (!["ADMIN", "MANAGER", "EMPLOYEE"].includes(role)) fail("Choose a valid role.");
  const branchId = text(req.body.branchId, "Inventory scope");
  if (branchId !== "LOCAL-WAREHOUSE") fail("Only the Taguig warehouse is available.", 403);
  Promise.resolve(hashPassword(password))
    .then((passwordHash) =>
      User.create({
        email,
        firstName,
        lastName,
        fullName,
        role,
        branchId,
        passwordHash,
      }),
    )
    .then((user) => res.status(201).json(json(user)))
    .catch(next);
});
export default router;
