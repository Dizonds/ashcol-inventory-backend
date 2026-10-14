import mongoose from "mongoose";
import { Counter, RequestReference, PartRequest, Movement } from "./models.js";

export async function reserveRequestReference(requestedBy, id = new mongoose.Types.ObjectId()) {
  const existing = await RequestReference.findById(id);
  if (existing) return existing;
  const counter = await Counter.findOneAndUpdate(
    { _id: "material-requests" },
    { $inc: { value: 1 } },
    { upsert: true, new: true },
  );
  const requestNumber = `REQ${String(counter.value).padStart(4, "0")}`;
  try {
    return await RequestReference.create({ _id: id, requestNumber, requestedBy });
  } catch (error) {
    // Another server may have assigned this same existing request concurrently.
    if (error.code === 11000) {
      const reference = await RequestReference.findById(id);
      if (reference) return reference;
    }
    throw error;
  }
}

export async function assignExistingRequestNumbers() {
  const requests = await PartRequest.find({ requestNumber: { $exists: false } })
    .sort({ createdAt: 1, _id: 1 });
  for (const request of requests) {
    const reference = await reserveRequestReference(request.requestedBy, request._id);
    // Preserve the original job reference and stock ledger linkage.
    await Movement.updateMany(
      { referenceId: String(request._id), movementType: "REQUEST_ISSUE" },
      { $set: { requestNumber: reference.requestNumber } },
    );
    await PartRequest.updateOne(
      { _id: request._id, requestNumber: { $exists: false } },
      { $set: { requestNumber: reference.requestNumber } },
    );
  }
}
