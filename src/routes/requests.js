import { Router } from "express";
import { Product, PartRequest } from "../models.js";
import { manage } from "../auth.js";
import {
  branchScope,
  number,
  text,
  fail,
  json,
  checkQuantity,
  transaction,
  changeStock,
  generateTicket,
} from "../helpers.js";

const router = Router();
router.get("/requests", (req, res, next) => {
  branchScope(req, req.query.branchId)
    .then((branchId) => PartRequest.find({ branchId }).sort({ createdAt: -1 }))
    .then((items) => res.json(items.map(json)))
    .catch(next);
});
router.post("/requests", (req, res, next) => {
  const quantityNeeded = number(req.body.quantityNeeded, "Requested quantity");
  if (!quantityNeeded) fail("Requested quantity must be positive.");
  const workOrderId = text(req.body.workOrderId, "Job / work-order number");
  const notes = text(req.body.notes || "", "Notes", false);
  branchScope(req, req.body.branchId)
    .then((branchId) =>
      transaction((session) => {
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
                  branchId,
                  productId: item._id,
                  sku: item.sku,
                  itemName: item.name,
                  unitOfMeasure: item.unitOfMeasure,
                  quantityNeeded,
                  workOrderId,
                  notes,
                  requestedBy: String(req.user._id),
                  requestedByName: req.user.fullName,
                },
              ],
              { session },
            );
          })
          .then(([request]) => json(request));
      }),
    )
    .then((item) => res.status(201).json(item))
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
        return PartRequest.findOne({ _id: req.params.id, branchId })
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
            request.status = status;
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
                  workOrderId: request.workOrderId,
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
          .then(json);
      }),
    )
    .then((item) => res.json(item))
    .catch(next);
});
export default router;
