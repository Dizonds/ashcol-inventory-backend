import mongoose from "mongoose";
import { Branch, Movement, Product } from "./models.js";

export function fail(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  throw error;
}
export function text(value, label, required = true) {
  if (typeof value !== "string" || value.trim().length > 200)
    fail(`${label} must be text of up to 200 characters.`);
  const clean = value.trim();
  if (required && !clean) fail(`${label} is required.`);
  return clean;
}
export function generateTicket(prefix = "SM") {
  const yy = String(new Date().getFullYear()).slice(-2);
  const rand = String(Math.floor(10 + Math.random() * 90));
  return `${prefix}${yy}${rand}`;
}
export function number(value, label) {
  if (
    value === "" ||
    value === null ||
    value === undefined ||
    !["number", "string"].includes(typeof value) ||
    (typeof value === "string" && !value.trim())
  )
    fail(`${label} is required.`);
  const result = Number(value);
  if (!Number.isFinite(result) || result < 0 || result > 100000000)
    fail(`${label} must be between 0 and 100,000,000.`);
  return result;
}
export function checkQuantity(quantity, unit) {
  if (
    [
      "UNIT",
      "PCS",
      "ROLL",
      "CYLINDER",
      "CYL",
      "PAIR",
      "CAN",
      "SET",
    ].includes(unit) &&
    !Number.isInteger(quantity)
  )
    fail(`Use whole numbers for ${unit}.`);
  if (Math.abs(quantity * 1000 - Math.round(quantity * 1000)) > 0.00001)
    fail("Use at most 3 decimal places for quantities.");
}
export function branchScope(req, branchId) {
  const id = text(branchId || req.user.branchId, "Branch");
  return Branch.findById(id).then((branch) => {
    if (!branch) fail("Branch not found.", 404);
    if (
      req.user.role !== "ADMIN" &&
      id !== req.user.branchId &&
      branch.branchType !== "SERVICE_VAN"
    ) {
      fail("You can only access your assigned branch.", 403);
    }
    return id;
  });
}
export function productData(body) {
  const data = {
    name: text(body.name, "Item name"),
    itemType: text(body.itemType, "Item type"),
    category: text(body.category, "Category"),
    brand: text(body.brand, "Brand"),
    capacity: text(body.capacity || "", "Specification", false),
    unitOfMeasure: text(body.unitOfMeasure, "Unit of measure"),
    unitCost: number(body.unitCost, "Unit cost"),
    listPrice: number(body.listPrice, "Selling price"),
    reorderLevel: number(body.reorderLevel, "Reorder level"),
    supplier: typeof body.supplier === "string" ? body.supplier.trim() : "",
    compatibleModels: Array.isArray(body.compatibleModels)
      ? body.compatibleModels.map((m) => String(m).trim()).filter(Boolean)
      : [],
  };
  const validTypes = [
    "AC Unit",
    "Material / Part",
    "Spare Part",
    "Consumable",
    "Tool / Equipment",
  ];
  if (!validTypes.includes(data.itemType))
    fail("Choose a supported item type: AC Unit, Spare Part, Consumable, or Tool / Equipment.");
  if (
    ![
      "UNIT",
      "PCS",
      "METER",
      "FOOT",
      "KG",
      "LITER",
      "ROLL",
      "CYLINDER",
      "CYL",
      "PAIR",
      "CAN",
      "SET",
    ].includes(data.unitOfMeasure)
  )
    fail("Choose a supported unit of measure.");
  const categoriesByType = {
    "AC Unit": ["Split Type", "Window Type", "Floor Mounted", "Portable"],
    "Material / Part": [
      "Compressors",
      "Refrigerants",
      "Installation Materials",
      "Copper Tubing",
      "Fan Motors",
      "PCBs & Inverters",
      "Capacitors",
      "Sensors & Thermostats",
    ],
    "Spare Part": [
      "Compressors",
      "Fan Motors",
      "PCBs & Inverters",
      "Capacitors",
      "Sensors & Thermostats",
      "Valves & Coils",
    ],
    "Consumable": [
      "Refrigerants",
      "Copper Tubing",
      "Installation Materials",
      "Insulation & Aerotape",
      "Drain Hoses & Fittings",
      "Brazing & Silver Rods",
    ],
    "Tool / Equipment": [
      "Vacuum Pumps",
      "Manifold Gauges",
      "Flaring & Swaging Tools",
      "Clamp & Multimeters",
      "Leak Detectors",
      "Hand Tools",
    ],
  };
  const allowedCategories = categoriesByType[data.itemType] || [];
  if (!allowedCategories.includes(data.category))
    fail(`Category "${data.category}" does not match the item type "${data.itemType}".`);
  if (data.itemType === "AC Unit" && data.unitOfMeasure !== "UNIT")
    fail("AC units must use UNIT.");
  checkQuantity(data.reorderLevel, data.unitOfMeasure);
  return data;
}
export function json(doc) {
  const result = doc.toObject();
  result.id = String(doc._id);
  delete result.passwordHash;
  delete result.__v;
  return result;
}
// One transaction saves the balance and audit entry together (requires a replica set).
export function transaction(work) {
  return mongoose.connection.transaction(work);
}
export function recordMovement(item, delta, details, user, session) {
  return Movement.create(
    [
      {
        productId: item._id,
        branchId: item.branchId,
        sku: item.sku,
        itemName: item.name,
        unitOfMeasure: item.unitOfMeasure,
        quantityDelta: delta,
        beforeQuantity: Math.round((item.quantity - delta) * 1000) / 1000,
        afterQuantity: item.quantity,
        performedBy: String(user._id),
        performedByName: user.fullName,
        ...details,
      },
    ],
    { session },
  );
}
export function changeStock(
  productId,
  branchId,
  delta,
  details,
  user,
  session,
) {
  return Product.findOne({ _id: productId, branchId, archived: false })
    .session(session)
    .then((item) => {
      if (!item) fail("Active inventory item not found.", 404);
      checkQuantity(Math.abs(delta), item.unitOfMeasure);
      const nextQuantity = Math.round((item.quantity + delta) * 1000) / 1000;
      if (nextQuantity < 0)
        fail("Insufficient stock. Refresh and try a smaller quantity.", 409);
      number(nextQuantity, "Resulting quantity");
      item.quantity = nextQuantity;
      return item.save({ session });
    })
    .then((item) =>
      recordMovement(item, delta, details, user, session).then(() => item),
    );
}
