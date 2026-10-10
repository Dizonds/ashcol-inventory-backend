import mongoose from "mongoose";

const options = { timestamps: true };
const productSchema = new mongoose.Schema(
  {
    branchId: { type: String, required: true },
    sku: { type: String, required: true, trim: true, uppercase: true },
    name: { type: String, required: true, trim: true },
    itemType: {
      type: String,
      enum: [
        "AC Unit",
        "Material / Part",
        "Spare Part",
        "Consumable",
        "Tool / Equipment",
      ],
      required: true,
    },
    category: { type: String, required: true },
    brand: { type: String, required: true },
    capacity: { type: String, default: "" },
    unitOfMeasure: {
      type: String,
      enum: [
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
      ],
      required: true,
    },
    unitCost: { type: Number, min: 0, required: true },
    listPrice: { type: Number, min: 0, required: true },
    quantity: { type: Number, min: 0, required: true },
    reorderLevel: { type: Number, min: 0, required: true },
    archived: { type: Boolean, default: false },
    supplier: { type: String, default: "" },
    compatibleModels: [{ type: String, trim: true }],
    priceHistory: [
      {
        cost: { type: Number, required: true },
        date: { type: Date, default: Date.now },
        supplier: { type: String, default: "" },
        note: { type: String, default: "" },
      },
    ],
  },
  options,
);
productSchema.index({ branchId: 1, sku: 1 }, { unique: true });

const movementSchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product" },
    branchId: String,
    sku: String,
    itemName: String,
    unitOfMeasure: String,
    movementType: String,
    quantityDelta: Number,
    beforeQuantity: Number,
    afterQuantity: Number,
    reason: String,
    workOrderId: String,
    referenceId: String,
    performedBy: String,
    performedByName: String,
    date: String, // Kept for imported, date-only legacy records.
  },
  options,
);
movementSchema.index({ branchId: 1, createdAt: -1 });

const userSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    firstName: { type: String, trim: true, default: "" },
    lastName: { type: String, trim: true, default: "" },
    fullName: { type: String, required: true },
    role: {
      type: String,
      enum: ["ADMIN", "MANAGER", "EMPLOYEE"],
      required: true,
    },
    branchId: { type: String, required: true },
    passwordHash: { type: String, required: true, select: false },
  },
  options,
);
const sessionSchema = new mongoose.Schema({
  tokenHash: { type: String, unique: true, required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  expiresAt: { type: Date, required: true, expires: 0 },
});
const requestSchema = new mongoose.Schema(
  {
    branchId: { type: String, required: true },
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },
    sku: String,
    itemName: String,
    unitOfMeasure: String,
    workOrderId: { type: String, required: true },
    quantityNeeded: { type: Number, required: true, min: 0 },
    notes: String,
    status: {
      type: String,
      enum: ["PENDING", "APPROVED", "DENIED", "FULFILLED"],
      default: "PENDING",
    },
    requestedBy: String,
    requestedByName: String,
    reviewedByName: String,
    reviewedAt: Date,
    decisionReason: String,
    fulfilledByName: String,
    fulfilledAt: Date,
  },
  options,
);

export const Product = mongoose.model("Product", productSchema, "products");
export const Movement = mongoose.model(
  "Movement",
  movementSchema,
  "stock_movements",
);
export const User = mongoose.model("User", userSchema);
export const Session = mongoose.model("Session", sessionSchema);
export const PartRequest = mongoose.model("PartRequest", requestSchema);
export const Branch = mongoose.model(
  "Branch",
  new mongoose.Schema(
    {
      _id: String,
      name: { type: String, required: true },
      branchType: {
        type: String,
        enum: ["WAREHOUSE", "SERVICE_VAN"],
        default: "WAREHOUSE",
      },
      plateNumber: { type: String, default: "" },
      driverId: { type: String, default: "" },
      driverName: { type: String, default: "" },
      status: {
        type: String,
        enum: ["AVAILABLE", "ON_FIELD", "ARRIVED", "MAINTENANCE"],
        default: "AVAILABLE",
      },
    },
    options,
  ),
);
export const Brand = mongoose.model(
  "Brand",
  new mongoose.Schema(
    {
      name: { type: String, required: true, unique: true, trim: true },
    },
    options,
  ),
  "brands",
);
export const Supplier = mongoose.model(
  "Supplier",
  new mongoose.Schema(
    {
      name: { type: String, required: true, unique: true, trim: true },
      contactPerson: { type: String, default: "" },
      phone: { type: String, default: "" },
      email: { type: String, default: "" },
      address: { type: String, default: "" },
      terms: { type: String, default: "" },
    },
    options,
  ),
  "suppliers",
);
