import "dotenv/config";
import fs from "node:fs/promises";
import mongoose from "mongoose";
import { Product, User, ServiceVan, Supplier, PartRequest, JobOrder } from "../src/models.js";
import { reserveRequestReference } from "../src/request-numbers.js";

// Idempotent: fills suppliers, vans, and technician/manager activity without touching existing products or accounts.
const readDemo = async (name) =>
  mongoose.mongo.BSON.EJSON.parse(await fs.readFile(new URL(`../demo-data-json/${name}.json`, import.meta.url), "utf8"));
const hoursAgo = (h) => new Date(Date.now() - h * 3600000);

async function main() {
  await mongoose.connect(
    process.env.MONGO_URI || "mongodb://127.0.0.1:27018/ashcol_inventory?replicaSet=rs0",
    { serverSelectionTimeoutMS: 5000 },
  );
  const manager = await User.findOne({ role: "MANAGER" }).lean();
  const tech = await User.findOne({ role: "EMPLOYEE" }).lean();
  if (!manager || !tech) throw new Error("Manager and technician accounts are required (npm run bootstrap first).");

  for (const { _id, __v, createdAt, updatedAt, ...data } of await readDemo("suppliers"))
    await Supplier.updateOne({ name: data.name }, { $setOnInsert: data }, { upsert: true });

  for (const { _id, __v, ...data } of await readDemo("service_vans"))
    await ServiceVan.updateOne({ _id }, { $setOnInsert: data }, { upsert: true, timestamps: false });

  // Technician drives VAN-01 and holds one open job on it.
  await ServiceVan.updateOne({ _id: "VAN-01" }, { $set: { driverId: String(tech._id), driverName: tech.fullName, status: "ON_FIELD" } });
  const van = await ServiceVan.findById("VAN-01").lean();
  const job = await JobOrder.findOneAndUpdate(
    { jobNumber: "AC-SRV-2026-44" },
    {
      $setOnInsert: {
        title: "Preventive maintenance - Makati office",
        customerName: "Makati Office Tower",
        location: "Ayala Ave, Makati City",
        description: "Quarterly servicing of split-type units; refrigerant top-up as needed.",
        assignedTechnicianId: tech._id, technicianName: tech.fullName,
        vanId: van._id, vanName: van.name,
        status: "OPEN", isCurrent: true, assignedAt: hoursAgo(30),
        assignedByName: manager.fullName, createdByName: manager.fullName,
      },
    },
    { upsert: true, new: true },
  );

  const bySku = async (sku) => Product.findOne({ sku, archived: { $ne: true } }).lean();
  const plan = [
    ["FRN-R410A-11.3", 2, "PENDING", 3, "Refrigerant top-up for Makati units"],
    ["COP-1/4-3/8-15M", 1, "APPROVED", 20, "Replacement copper line set"],
    ["MAT-DRAIN-HOSE", 3, "PENDING", 6, "Clogged drain hoses on floor 4"],
    ["MAT-CAP-35-5MFD", 4, "DENIED", 40, "Capacitors for stock", "Not tied to an active job; submit per-unit request."],
  ];
  let added = 0;
  for (const [sku, quantityNeeded, status, age, notes, decisionReason] of plan) {
    const product = await bySku(sku);
    if (!product) { console.warn(`Skipped ${sku}: not in inventory.`); continue; }
    if (await PartRequest.exists({ jobNumber: job.jobNumber, sku, notes })) continue;
    const _id = new mongoose.Types.ObjectId();
    const { requestNumber } = await reserveRequestReference(tech.email, _id);
    const at = hoursAgo(age);
    const reviewed = status !== "PENDING";
    await PartRequest.create({
      _id, requestNumber, jobNumber: job.jobNumber, jobId: job._id, branchId: product.branchId,
      destinationVanId: van._id, destinationVanName: van.name,
      productId: product._id, sku: product.sku, itemName: product.name, itemType: product.itemType,
      category: product.category, brand: product.brand, unitOfMeasure: product.unitOfMeasure,
      quantityNeeded, notes, status, decisionReason,
      requestedBy: tech.email, requestedByName: tech.fullName,
      ...(reviewed && { reviewedByName: manager.fullName, reviewedAt: new Date(at.getTime() + 1800000) }),
      history: [
        { status: "PENDING", performedByName: tech.fullName, at },
        ...(reviewed ? [{ status, performedByName: manager.fullName, at: new Date(at.getTime() + 1800000), reason: decisionReason }] : []),
      ],
      createdAt: at, updatedAt: at,
    });
    added += 1;
  }

const compatibilityMap = {
  "FRN-R410A-11.3": ["CAR-1.0HP-CRY", "CAR-1.5HP-INV", "CAR-2.0HP-INV", "KOL-1.0HP-WINV", "GREE-3.0TR-FLR", "TCL-1.0HP-PORT"],
  "FRN-R32-9.5KG": ["DAIK-1.0HP-INV", "DAIK-1.5HP-INV", "PANA-1.5HP-XPU", "MIDEA-5.0TR-FLR"],
  "FRN-R134A-13.6": ["KOL-0.75HP-WND"],
  "COP-1/4-3/8-15M": ["DAIK-1.0HP-INV", "CAR-1.0HP-CRY", "TCL-1.0HP-PORT"],
  "COP-1/4-1/2-15M": ["DAIK-1.5HP-INV", "CAR-1.5HP-INV", "CAR-2.0HP-INV", "PANA-1.5HP-XPU"],
  "CMP-GMCC-1.5HP": ["CAR-1.5HP-INV", "MIDEA-5.0TR-FLR"],
  "CMP-LG-2.0HP-ROT": ["CAR-2.0HP-INV"],
  "MAT-DRAIN-HOSE": ["DAIK-1.0HP-INV", "DAIK-1.5HP-INV", "CAR-1.0HP-CRY", "CAR-1.5HP-INV", "CAR-2.0HP-INV", "PANA-1.5HP-XPU", "GREE-3.0TR-FLR", "MIDEA-5.0TR-FLR", "TCL-1.0HP-PORT"],
  "MAT-WALL-BRKT-L": ["DAIK-1.0HP-INV", "DAIK-1.5HP-INV", "CAR-1.0HP-CRY", "CAR-1.5HP-INV", "CAR-2.0HP-INV", "PANA-1.5HP-XPU"],
  "MAT-CAP-35-5MFD": ["CAR-1.0HP-CRY", "CAR-1.5HP-INV", "KOL-0.75HP-WND", "KOL-1.0HP-WINV"],
};
  for (const [sku, models] of Object.entries(compatibilityMap))
    await Product.updateMany({ sku }, { $set: { compatibleModels: models } });

  console.log(`Seeded: ${await Supplier.countDocuments()} suppliers, ${await ServiceVan.countDocuments()} vans, job ${job.jobNumber}, ${added} new requests.`);
}

main()
  .catch((error) => { console.error("Seeding failed:", error.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect());
