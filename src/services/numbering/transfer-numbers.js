import mongoose from "mongoose";
import { Counter, Movement } from "../../database/models.js";

const prefixes = { TRANSFER_OUT: "TRO", TRANSFER_IN: "TRI" };

export async function reserveTransferNumber(movementType, session) {
  const prefix = prefixes[movementType];
  if (!prefix) return undefined;
  return reserveNumber(prefix, session);
}

export async function reserveVehicleReceiptNumber(details, session) {
  if (details.movementType !== "TRANSFER_IN" || !details.requestNumber) return undefined;
  return reserveNumber("VAN", session);
}

async function reserveNumber(prefix, session) {
  const counter = await Counter.findOneAndUpdate(
    { _id: prefix }, { $inc: { value: 1 } }, { upsert: true, new: true, session },
  );
  return `${prefix}${String(counter.value).padStart(4, "0")}`;
}

export async function assignExistingTransferNumbers() {
  // Resume after existing numbers if counters were restored independently.
  for (const [prefix, field] of [...Object.values(prefixes).map((prefix) => [prefix, "transferNumber"]), ["VAN", "vehicleReceiptNumber"]]) {
    const [existing] = await Movement.aggregate([
      { $match: { [field]: new RegExp(`^${prefix}\\d+$`) } },
      { $project: { sequence: { $convert: { input: { $substrBytes: [`$${field}`, 3, -1] }, to: "double", onError: 0 } } } },
      { $group: { _id: null, highest: { $max: "$sequence" } } },
    ]);
    await Counter.updateOne({ _id: prefix }, { $max: { value: existing?.highest || 0 } }, { upsert: true });
  }
  const legacy = await Movement.find({ movementType: { $in: Object.keys(prefixes) }, transferNumber: { $exists: false } })
    .sort({ createdAt: 1, _id: 1 }).select("_id").lean();
  for (const entry of legacy) {
    await mongoose.connection.transaction(async (session) => {
      const movement = await Movement.findById(entry._id).session(session);
      if (!movement || movement.transferNumber) return;
      const transferNumber = await reserveTransferNumber(movement.movementType, session);
      // Keep original references, quantities and timestamps as historical evidence.
      await Movement.updateOne({ _id: movement._id }, { $set: { transferNumber } }, { session, timestamps: false });
    });
  }
  const receipts = await Movement.find({ movementType: "TRANSFER_IN", requestNumber: { $type: "string", $ne: "" }, vehicleReceiptNumber: { $exists: false } })
    .sort({ createdAt: 1, _id: 1 }).select("_id").lean();
  for (const entry of receipts) {
    await mongoose.connection.transaction(async (session) => {
      const movement = await Movement.findById(entry._id).session(session);
      if (!movement || movement.vehicleReceiptNumber) return;
      const vehicleReceiptNumber = await reserveVehicleReceiptNumber(movement, session);
      await Movement.updateOne({ _id: movement._id }, { $set: { vehicleReceiptNumber } }, { session, timestamps: false });
    });
  }
}
