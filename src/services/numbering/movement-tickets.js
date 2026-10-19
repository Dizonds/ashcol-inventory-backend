import { Counter, Movement, MovementTicket } from "../../database/models.js";

export async function reserveMovementTicket(movementType, requestedBy, branchId) {
  const prefix = { STOCK_IN: "STI", STOCK_OUT: "STO", JOB_CONSUMPTION: "USE" }[movementType];
  if (!prefix) throw new Error("Unsupported movement ticket type.");
  // Continue from existing numbered ledger tickets when creating a counter.
  if (!await Counter.exists({ _id: prefix })) {
    const [existing] = await Movement.aggregate([
      { $match: { referenceId: new RegExp(`^${prefix}\\d+$`) } },
      { $project: { sequence: { $convert: { input: { $substrBytes: ["$referenceId", 3, -1] }, to: "double", onError: 0 } } } },
      { $group: { _id: null, highest: { $max: "$sequence" } } },
    ]);
    await Counter.findOneAndUpdate(
      { _id: prefix }, { $max: { value: existing?.highest || 0 } }, { upsert: true },
    );
  }
  const counter = await Counter.findOneAndUpdate(
    { _id: prefix }, { $inc: { value: 1 } }, { new: true },
  );
  return MovementTicket.create({
    _id: `${prefix}${String(counter.value).padStart(4, "0")}`,
    movementType,
    requestedBy,
    ...(branchId ? { branchId } : {}),
  });
}
