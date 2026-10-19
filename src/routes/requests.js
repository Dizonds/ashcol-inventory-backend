import { Router } from "express";
import mongoose from "mongoose";
import { Product, PartRequest, RequestReference, ServiceVan, User, JobOrder } from "../database/models.js";
import { reserveRequestReference } from "../services/numbering/request-numbers.js";
import { manage } from "../security/auth.js";
import {
  branchScope,
  number,
  text,
  fail,
  inventoryRecordJson,
  checkQuantity,
  transaction,
  changeStock,
  lockServiceVan,
  productData,
} from "../utils/helpers.js";

const router = Router();
const requestJson = (request) => inventoryRecordJson(request);

async function requestVehicle(user, session) {
  const filter = { $or: [
    { driverId: String(user._id) },
    { driverId: { $in: ["", null] }, driverName: { $in: [user.fullName, `${user.fullName} (${user.role})`] } },
  ] };
  const van = session
    ? await ServiceVan.findOneAndUpdate(filter, { $inc: { __v: 1 } }, { new: true, session })
    : await ServiceVan.findOne(filter);
  if (!van) fail("An assigned service vehicle is required before requesting materials. Ask your admin or manager to assign one.", 409);
  return van;
}

router.get("/requests/reference", (req, res, next) => {
  Promise.resolve(req.user.role === "EMPLOYEE" ? requestVehicle(req.user) : null)
    .then(() => reserveRequestReference(String(req.user._id)))
    .then((reference) => res.json({ id: String(reference._id), requestNumber: reference.requestNumber }))
    .catch(next);
});
router.get("/requests", (req, res, next) => {
  branchScope(req, req.query.branchId)
    .then((branchId) => PartRequest.find({
      branchId,
      ...(req.user.role === "EMPLOYEE" ? { requestedBy: String(req.user._id) } : {}),
      ...(req.query.includeDeleted === "true" ? {} : { deletedAt: { $exists: false } }),
    }).sort({ createdAt: -1 }).populate("productId", "brand itemType category"))
    .then((items) => res.json(items.map(requestJson)))
    .catch(next);
});
router.post("/requests", (req, res, next) => {
  const quantityNeeded = number(req.body.quantityNeeded, "Requested quantity");
  if (!quantityNeeded) fail("Requested quantity must be positive.");
  if (req.body.requestId !== undefined &&
      (typeof req.body.requestId !== "string" || !/^[a-f0-9]{24}$/i.test(req.body.requestId)))
    fail("Invalid request ID.");
  if (req.body.jobId !== undefined && !mongoose.isValidObjectId(req.body.jobId))
    fail("Invalid job ID.");
  const requestId = new mongoose.Types.ObjectId(req.body.requestId);
  const notes = text(req.body.notes || "", "Notes", false);
  branchScope(req, req.body.branchId)
    .then(async (branchId) => {
      const reference = req.body.requestId === undefined
        ? await reserveRequestReference(String(req.user._id), requestId)
        : await RequestReference.findById(requestId);
      if (!reference) fail("Request ID not found. Open a new request and try again.");
      if (reference.requestedBy !== String(req.user._id)) fail("This request ID belongs to another account.", 403);
      return transaction(async (session) => {
        if (req.user.role === "EMPLOYEE" && branchId !== "LOCAL-WAREHOUSE")
          fail("Request materials from the warehouse for your assigned vehicle.");
        const destination = req.user.role === "EMPLOYEE" ? await requestVehicle(req.user, session) : null;
        const job = req.body.jobId === undefined ? null : await JobOrder.findOne({ _id: req.body.jobId, status: "OPEN" }).session(session);
        if (req.body.jobId !== undefined && !job) fail("Choose an open job order.", 404);
        if (job && req.user.role === "EMPLOYEE" &&
            (String(job.assignedTechnicianId) !== String(req.user._id) || !job.isCurrent))
          fail("You can only link a request to your current job.", 403);
        if (job && destination && job.vanId !== destination._id)
          fail("The selected job must be assigned to your service vehicle.", 409);
        await lockServiceVan(branchId, session);
        // Touch the product so request creation cannot race with archiving.
        return Product.findOneAndUpdate(
          { _id: req.body.productId, branchId, archived: false },
          { $inc: { __v: 1 } },
          { new: true, session },
        )
          .then((item) => {
            if (!item) fail("Active item not found.", 404);
            checkQuantity(quantityNeeded, item.unitOfMeasure);
            return PartRequest.create(
              [
                {
                  _id: requestId,
                  requestNumber: reference.requestNumber,
                  branchId,
                  ...(job ? { jobId: job._id, jobNumber: job.jobNumber } : {}),
                  ...(destination ? { destinationVanId: destination._id, destinationVanName: destination.name } : {}),
                  productId: item._id,
                  sku: item.sku,
                  itemName: item.name,
                  itemType: item.itemType,
                  category: item.category,
                  brand: item.brand,
                  unitOfMeasure: item.unitOfMeasure,
                  quantityNeeded,
                  notes,
                  requestedBy: String(req.user._id),
                  requestedByName: req.user.fullName,
                  history: [{ status: "PENDING", performedByName: req.user.fullName, at: new Date() }],
                },
              ],
              { session },
            );
          })
          .then(([request]) => requestJson(request));
      });
    })
    .then((item) => res.status(201).json(item))
    .catch(next);
});
router.delete("/requests/:id", (req, res, next) => {
  branchScope(req, req.body.branchId)
    .then((branchId) => transaction(async (session) => {
      const request = await PartRequest.findOneAndUpdate(
        { _id: req.params.id, branchId, deletedAt: { $exists: false } },
        { $inc: { __v: 1 } }, { new: true, session },
      );
      if (!request) fail("Request not found or already deleted.", 404);
      if (req.user.role === "EMPLOYEE") {
        if (request.requestedBy !== String(req.user._id)) fail("You can only delete your own requests.", 403);
        if (request.status !== "PENDING") fail("Only pending requests can be deleted by technicians.", 403);
      } else if (!["ADMIN", "MANAGER"].includes(req.user.role)) {
        fail("You do not have permission to delete requests.", 403);
      }
      if (!request.history.length) {
        if (request.createdAt) request.history.push({ status: "PENDING", performedByName: request.requestedByName, at: request.createdAt });
        if (request.reviewedAt) request.history.push({ status: request.status === "DENIED" ? "DENIED" : "APPROVED", performedByName: request.reviewedByName, at: request.reviewedAt, reason: request.decisionReason });
        if (request.fulfilledAt) request.history.push({ status: "FULFILLED", performedByName: request.fulfilledByName, at: request.fulfilledAt });
      }
      request.deletedAt = new Date();
      request.deletedByName = req.user.fullName;
      request.history.push({ status: "DELETED", performedByName: req.user.fullName, at: request.deletedAt });
      await request.save({ session });
      return requestJson(request);
    }))
    .then((request) => res.json(request))
    .catch(next);
});
router.patch("/requests/:id", manage, (req, res, next) => {
  const status = text(req.body.status, "Status");
  if (!["APPROVED", "DENIED", "FULFILLED"].includes(status))
    fail("Invalid request transition.");
  const decisionReason = text(
    req.body.decisionReason || "",
    "Decision reason",
    status === "DENIED",
  );
  branchScope(req, req.body.branchId)
    .then((branchId) =>
      transaction((session) => {
        return PartRequest.findOne({ _id: req.params.id, branchId, deletedAt: { $exists: false } })
          .session(session)
          .then(async (request) => {
            if (!request) fail("Request not found.", 404);
            if (
              (status === "APPROVED" && request.status !== "PENDING") ||
              (status === "DENIED" &&
                !["PENDING", "APPROVED"].includes(request.status)) ||
              (status === "FULFILLED" && request.status !== "APPROVED")
            )
              fail("This request has already changed. Refresh the list.", 409);
            if (!request.history.length) {
              request.history.push({ status: "PENDING", performedByName: request.requestedByName, at: request.createdAt });
              if (request.reviewedAt) request.history.push({
                status: request.status === "DENIED" ? "DENIED" : "APPROVED",
                performedByName: request.reviewedByName,
                at: request.reviewedAt,
                reason: request.decisionReason,
              });
            }
            request.status = status;
            request.history.push({
              status,
              performedByName: req.user.fullName,
              at: new Date(),
              reason: decisionReason,
            });
            if (status === "FULFILLED") {
              // Validate the original recipient before either side of the transfer changes.
              const requester = mongoose.isValidObjectId(request.requestedBy)
                ? await User.findByIdAndUpdate(request.requestedBy, { $inc: { __v: 1 } }, { new: true, session }) : null;
              let destination;
              if (request.destinationVanId || requester?.role === "EMPLOYEE") {
                if (!requester || requester.role !== "EMPLOYEE") fail("The requesting technician is no longer available. Deny this request and create a new one.", 409);
                destination = await requestVehicle(requester, session);
                if (request.destinationVanId && destination._id !== request.destinationVanId)
                  fail("The technician's vehicle assignment has changed. Deny this request and ask them to submit a new request for their current vehicle.", 409);
                if (branchId !== "LOCAL-WAREHOUSE") fail("Technician material requests must be fulfilled from the warehouse.", 409);
                request.destinationVanId = destination._id;
                request.destinationVanName = destination.name;
              }
              request.fulfilledByName = req.user.fullName;
              request.fulfilledAt = new Date();
              const source = await changeStock(
                request.productId,
                branchId,
                -request.quantityNeeded,
                {
                  movementType: "REQUEST_ISSUE",
                  reason: "Approved material request fulfilled",
                  requestNumber: request.requestNumber,
                  referenceId: String(request._id),
                },
                req.user,
                session,
              );
              if (destination) {
                let target = await Product.findOne({ branchId: destination._id, sku: source.sku }).session(session);
                if (target && (target.archived || ["unitOfMeasure", "itemType", "name", "brand", "capacity"]
                  .some((field) => target[field] !== source[field])))
                  fail("Destination SKU is archived or its item details differ. Resolve the catalog mismatch first.", 409);
                if (!target) [target] = await Product.create([{
                  ...productData(source), brandId: source.brandId, supplierId: source.supplierId,
                  sku: source.sku, branchId: destination._id, quantity: 0,
                }], { session });
                await changeStock(target._id, destination._id, request.quantityNeeded, {
                  movementType: "TRANSFER_IN", reason: "Approved material request received in assigned vehicle",
                  requestNumber: request.requestNumber, referenceId: String(request._id),
                }, req.user, session);
              }
              return request.save({ session });
            }
            request.reviewedByName = req.user.fullName;
            request.reviewedAt = new Date();
            request.decisionReason = decisionReason;
            return request.save({ session });
          })
          .then(requestJson);
      }),
    )
    .then((item) => res.json(item))
    .catch(next);
});
export default router;
