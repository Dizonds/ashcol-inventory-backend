import { Router } from "express";
import mongoose from "mongoose";
import { Product, PartRequest, RequestReference } from "../models.js";
import { reserveRequestReference } from "../request-numbers.js";
import { manage } from "../auth.js";
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
} from "../helpers.js";

const router = Router();
const requestJson = (request) => inventoryRecordJson(request);

router.get("/requests/reference", (req, res, next) => {
  reserveRequestReference(String(req.user._id))
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
                  productId: item._id,
                  sku: item.sku,
                  itemName: item.name,
                  itemType: item.itemType,
                  category: item.category,
                  brand: item.brand,
                  unitOfMeasure: item.unitOfMeasure,
                  quantityNeeded,
                  workOrderId: reference.requestNumber,
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
          .then((request) => {
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
              request.fulfilledByName = req.user.fullName;
              request.fulfilledAt = new Date();
              return changeStock(
                request.productId,
                branchId,
                -request.quantityNeeded,
                {
                  movementType: "REQUEST_ISSUE",
                  reason: "Approved material request fulfilled",
                  workOrderId: request.requestNumber,
                  requestNumber: request.requestNumber,
                  referenceId: String(request._id),
                },
                req.user,
                session,
              ).then(() => request.save({ session }));
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
