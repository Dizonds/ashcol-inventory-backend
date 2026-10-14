import { Router } from "express";
import { ServiceVan, Brand, User, Supplier, Product, PartRequest, Session, Counter } from "../models.js";
import { admin, manage, hashPassword } from "../auth.js";
import { text, fail, json, transaction, lockServiceVan } from "../helpers.js";

const router = Router();

function isAssignedToUser(van, user) {
  return (
    van.driverId === String(user._id) ||
    van.driverName === user.fullName ||
    van.driverName === `${user.fullName} (${user.role})`
  );
}

function resolveDriver(driverId, driverName, session) {
  const id = text(driverId || "", "Driver", false);
  const name = text(driverName || "", "Driver", false);
  if (!id && !name) return Promise.resolve({ driverId: "", driverName: "" });
  const lookup = id
    ? User.findById(id)
    : User.findOne({
        $or: [
          { fullName: name },
          { fullName: name.replace(/\s+\([^)]*\)$/, "") },
        ],
      });
  return lookup.session(session || null).then(async (user) => {
    if (!user) fail("Selected driver/technician was not found.", 404);
    if (session) {
      // Coordinate assignment with account removal so deleted users cannot become drivers.
      user = await User.findByIdAndUpdate(user._id, { $inc: { __v: 1 } }, { new: true, session });
      if (!user) fail("Selected driver/technician was not found.", 404);
    }
    return { driverId: String(user._id), driverName: user.fullName };
  });
}

function ensureDriverAvailable(driver, vehicleId, session) {
  if (!driver.driverId) return Promise.resolve();
  return ServiceVan.findOne({
    _id: { $ne: vehicleId },
    $or: [
      { driverId: driver.driverId },
      { driverName: driver.driverName },
      { driverName: `${driver.driverName} (EMPLOYEE)` },
      { driverName: `${driver.driverName} (MANAGER)` },
      { driverName: `${driver.driverName} (ADMIN)` },
    ],
  }).session(session || null).then((existing) => {
    if (existing)
      fail(`${driver.driverName} is already assigned to ${existing.name}.`, 409);
  });
}

router.get("/service-vans", (req, res, next) => {
  const filter =
    req.user.role === "EMPLOYEE"
      ? {
          $or: [
            { driverId: String(req.user._id) },
            { driverName: req.user.fullName },
            { driverName: `${req.user.fullName} (${req.user.role})` },
          ],
        }
      : {};
  ServiceVan.find(filter)
    .sort({ name: 1 })
    .then((items) => res.json(items.map(json)))
    .catch(next);
});
router.post("/service-vans", admin, (req, res, next) => {
  const id = text(req.body.id, "Vehicle ID");
  if (!/^[A-Za-z0-9-]+$/.test(id))
    fail("Use letters, numbers and hyphens for vehicle IDs.");
  const plateNumber = text(req.body.plateNumber || "", "Plate number", false);
  const status = ["AVAILABLE", "ON_FIELD", "ARRIVED", "MAINTENANCE"].includes(
    req.body.status,
  )
    ? req.body.status
    : "AVAILABLE";
  transaction(async (session) => {
    const driver = await resolveDriver(req.body.driverId, req.body.driverName, session);
    await ensureDriverAvailable(driver, id, session);
    const [vehicle] = await ServiceVan.create([{
      _id: id, name: text(req.body.name, "Vehicle name"), plateNumber, ...driver, status,
    }], { session });
    return vehicle;
  })
    .then((item) => res.status(201).json(json(item)))
    .catch(next);
});
// Only idle, unassigned, empty vehicles can be removed.
router.delete("/service-vans/:id", admin, (req, res, next) => {
  if (req.params.id === "LOCAL-WAREHOUSE") fail("The warehouse is not a service vehicle.");
  transaction(async (session) => {
    const van = await lockServiceVan(req.params.id, session);
    if (van.driverId?.trim() || van.driverName?.trim() || van.status !== "AVAILABLE")
      fail("Vehicle is busy. Unassign its driver and set it to Available before deleting it.", 409);
    if (await Product.exists({ branchId: van._id, quantity: { $gt: 0 } }).session(session))
      fail("Vehicle is busy. Return all stock to the warehouse before deleting it.", 409);
    if (await PartRequest.exists({ branchId: van._id, status: { $in: ["PENDING", "APPROVED"] } }).session(session))
      fail("Vehicle is busy. Resolve its open material requests before deleting it.", 409);
    await ServiceVan.deleteOne({ _id: van._id }, { session });
  })
    .then(() => res.json({ success: true, message: "Service vehicle deleted." }))
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
      if (req.user.role === "EMPLOYEE" && !isAssignedToUser(van, req.user))
        fail("Employees can only update their assigned service vehicle.", 403);
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
  transaction(async (session) => {
      const van = await ServiceVan.findById(req.params.id).session(session);
      if (!van) fail("Service vehicle not found.", 404);
      if (["ON_FIELD", "ARRIVED"].includes(van.status))
        fail(
          "The driver cannot be changed after the vehicle has been dispatched or has arrived on site.",
          409,
        );
      const driver = await resolveDriver(req.body.driverId, req.body.driverName, session);
      await ensureDriverAvailable(driver, req.params.id, session);
      const updated = await ServiceVan.findByIdAndUpdate(
        req.params.id,
        { $set: driver },
        { new: true, session },
      );
      if (!updated) fail("Service vehicle not found.", 404);
      return updated;
    })
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
  const updateData = {
    name,
    contactPerson: text(req.body.contactPerson || "", "Contact person", false),
    phone: text(req.body.phone || "", "Phone", false),
    email: text(req.body.email || "", "Email", false),
    address: text(req.body.address || "", "Address", false),
    terms: text(req.body.terms || "", "Terms", false),
  };

  const id = req.body.id;
  if (id) {
    Supplier.findByIdAndUpdate(id, { $set: updateData }, { new: true })
      .then((item) => {
        if (!item) fail("Supplier not found.", 404);
        res.json(json(item));
      })
      .catch(next);
  } else {
    Supplier.findOneAndUpdate(
      { name },
      { $set: updateData },
      { upsert: true, new: true },
    )
      .then((item) => res.status(201).json(json(item)))
      .catch(next);
  }
});
router.delete("/suppliers/:id", manage, (req, res, next) => {
  Supplier.findByIdAndDelete(req.params.id)
    .then((item) => {
      if (!item) fail("Supplier not found.", 404);
      res.json({ success: true, message: "Supplier deleted." });
    })
    .catch(next);
});
router.get("/users", manage, (req, res, next) => {
  User.find()
    .sort({ fullName: 1 })
    .then((items) => res.json(items.map(json)))
    .catch(next);
});
router.delete("/users/:id", admin, (req, res, next) => {
  transaction(async (session) => {
    // Serialize removals so two administrators cannot remove each other at once.
    await Counter.findOneAndUpdate(
      { _id: "user-administration" }, { $inc: { value: 1 } }, { upsert: true, new: true, session },
    );
    const administrator = await User.findById(req.user._id).session(session);
    if (!administrator || administrator.role !== "ADMIN") fail("Your session expired. Please sign in.", 401);
    const user = await User.findById(req.params.id).session(session);
    if (!user) fail("User account not found.", 404);
    if (String(user._id) === String(administrator._id)) fail("You cannot remove your own signed-in account.", 409);
    if (user.role === "ADMIN" && await User.countDocuments({ role: "ADMIN" }).session(session) <= 1)
      fail("The last administrator account cannot be removed.", 409);
    const assignedVehicle = await ServiceVan.findOne({ $or: [
      { driverId: String(user._id) },
      { driverName: user.fullName },
      { driverName: `${user.fullName} (${user.role})` },
    ] }).session(session);
    if (assignedVehicle) fail(`This user is assigned to ${assignedVehicle.name}. Select No Driver on that vehicle before removing the account.`, 409);
    await Session.deleteMany({ userId: user._id }, { session });
    await User.deleteOne({ _id: user._id }, { session });
  })
    .then(() => res.json({ success: true, message: "User account removed." }))
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
  const password = typeof req.body.password === "string" ? req.body.password : "";
  if (!password.trim()) fail("Password is required.");
  if (/\s/.test(password)) fail("Password cannot contain spaces.");
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
