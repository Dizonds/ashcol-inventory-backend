import mongoose from "mongoose";

const options = { timestamps: true };
export const VEHICLE_TYPES = ["Cargo Van", "Pickup", "SUV"];
// Existing fleet records remain editable while registration uses the current types.
const LEGACY_VEHICLE_TYPES = ["Cab Chassis", "Hatchback", "Micro SUV"];
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
    itemType: String,
    category: String,
    brand: String,
    unitOfMeasure: String,
    movementType: String,
    isVehicleReturn: Boolean,
    quantityDelta: Number,
    beforeQuantity: Number,
    afterQuantity: Number,
    reason: String,
    workOrderId: String,
    jobOrderId: { type: mongoose.Schema.Types.ObjectId, ref: "JobOrder" },
    referenceId: String,
    transferNumber: String,
    vehicleReceiptNumber: String,
    requestNumber: String,
    performedBy: String,
    performedByName: String,
    date: String, // Kept for imported, date-only legacy records.
  },
  options,
);
movementSchema.index({ branchId: 1, createdAt: -1 });
movementSchema.index({ jobOrderId: 1, createdAt: -1 });
movementSchema.index({ transferNumber: 1 }, { unique: true, sparse: true });
movementSchema.index({ vehicleReceiptNumber: 1 }, { unique: true, sparse: true });

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
    availability: { type: String, enum: ["AVAILABLE", "BUSY", "AWAY"], default: "AVAILABLE" },
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
    requestNumber: { type: String, unique: true, sparse: true },
    branchId: { type: String, required: true },
    destinationVanId: String,
    destinationVanName: String,
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },
    sku: String,
    itemName: String,
    itemType: String,
    category: String,
    brand: String,
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
    deletedAt: Date,
    deletedByName: String,
    history: [{
      _id: false,
      status: { type: String, enum: ["PENDING", "APPROVED", "DENIED", "FULFILLED", "DELETED"], required: true },
      performedByName: String,
      at: { type: Date, required: true },
      reason: String,
    }],
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
export const RequestReference = mongoose.model("RequestReference", new mongoose.Schema({
  requestNumber: { type: String, required: true, unique: true },
  requestedBy: String,
}));
export const Counter = mongoose.model("Counter", new mongoose.Schema({
  _id: String,
  value: { type: Number, required: true },
}));
export const JobOrder = mongoose.model("JobOrder", new mongoose.Schema({
  jobNumber: { type: String, required: true, unique: true },
  title: { type: String, required: true },
  customerName: { type: String, required: true },
  location: { type: String, required: true },
  description: { type: String, default: "" },
  assignedTechnicianId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  technicianName: { type: String, required: true },
  vanId: { type: String, required: true },
  vanName: { type: String, required: true },
  status: { type: String, enum: ["OPEN", "COMPLETED", "CANCELLED"], default: "OPEN" },
  isCurrent: { type: Boolean, default: false },
  assignedAt: Date,
  assignedByName: String,
  createdByName: String,
  closedAt: Date,
  closedByName: String,
}, options)
  .index({ assignedTechnicianId: 1, status: 1, vanId: 1 })
  .index({ assignedTechnicianId: 1 }, { unique: true, partialFilterExpression: { isCurrent: true } })
  .index({ vanId: 1 }, { unique: true, partialFilterExpression: { isCurrent: true } }));
export const MovementTicket = mongoose.model("MovementTicket", new mongoose.Schema({
  _id: String,
  movementType: { type: String, enum: ["STOCK_IN", "STOCK_OUT", "JOB_CONSUMPTION"], required: true },
  requestedBy: { type: String, required: true },
  branchId: String,
  usedAt: Date,
}));
// Mobile fleet records live separately from the fixed Taguig warehouse.
export const ServiceVan = mongoose.model(
  "ServiceVan",
  (() => {
    const schema = new mongoose.Schema(
      {
        _id: String,
        name: { type: String, required: true },
        plateNumber: { type: String, default: "" },
        vehicleType: { type: String, enum: ["", ...VEHICLE_TYPES, ...LEGACY_VEHICLE_TYPES], default: "" },
        driverId: { type: String, default: "" },
        driverName: { type: String, default: "" },
        status: {
          type: String,
          enum: ["AVAILABLE", "ON_FIELD", "ARRIVED", "MAINTENANCE"],
          default: "AVAILABLE",
        },
      },
      options,
    );
    schema.index(
      { driverId: 1 },
      { unique: true, partialFilterExpression: { driverId: { $gt: "" } } },
    );
    return schema;
  })(),
  "service_vans",
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
      archived: { type: Boolean, default: false },
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
