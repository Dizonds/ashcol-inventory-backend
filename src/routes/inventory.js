import { Router } from "express";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { Product, Movement, ServiceVan, PartRequest, MovementTicket, JobOrder } from "../models.js";
import { reserveMovementTicket } from "../movement-tickets.js";
import { manage, admin } from "../auth.js";
import {
  branchScope,
  productData,
  productDirectoryReferences,
  number,
  text,
  fail,
  json,
  inventoryRecordJson,
  checkQuantity,
  transaction,
  recordMovement,
  changeStock,
} from "../helpers.js";

const router = Router();
router.post("/movement-tickets", manage, (req, res, next) => {
  const movementType = text(req.body.movementType, "Movement type");
  if (!["STOCK_IN", "STOCK_OUT"].includes(movementType)) fail("Invalid movement type.");
  reserveMovementTicket(movementType, String(req.user._id))
    .then((ticket) => res.status(201).json({ referenceId: ticket._id, movementType: ticket.movementType }))
    .catch(next);
});
router.get("/products", (req, res, next) => {
  branchScope(req, req.query.branchId)
    .then((branchId) =>
      Promise.all([
        Product.find({ branchId, archived: req.query.archived === "true" }).sort({
          name: 1,
        }),
        PartRequest.find({ branchId, status: "APPROVED", deletedAt: { $exists: false } }),
      ]),
    )
    .then(([items, approvedRequests]) => {
      const reservedMap = {};
      approvedRequests.forEach((req) => {
        const pid = String(req.productId);
        reservedMap[pid] = (reservedMap[pid] || 0) + (req.quantityNeeded || 0);
      });
      const enriched = items.map((doc) => {
        const itemObj = json(doc);
        itemObj.approvedRequestQuantity = reservedMap[itemObj.id] || 0;
        // Approval is demand awaiting fulfillment, not a stock reservation.
        itemObj.reservedQuantity = 0;
        itemObj.availableQuantity = itemObj.quantity;
        return itemObj;
      });
      res.json(enriched);
    })
    .catch(next);
});
router.post("/products", manage, (req, res, next) => {
  const data = productData(req.body);
  data.sku = text(req.body.sku, "SKU").toUpperCase();
  data.quantity = number(req.body.quantity, "Opening quantity");
  checkQuantity(data.quantity, data.unitOfMeasure);
  data.priceHistory = [
    {
      cost: data.unitCost,
      date: new Date(),
      supplier: data.supplier,
      note: "Initial registration cost",
    },
  ];
  branchScope(req, req.body.branchId)
    .then((branchId) =>
      transaction(async (session) => {
        const directoryReferences = await productDirectoryReferences(data, session);
        const [item] = await Product.create([{ ...data, ...directoryReferences, branchId }], { session });
        await recordMovement(
          item,
          item.quantity,
          { movementType: "OPENING", reason: "Initial opening stock" },
          req.user,
          session,
        );
        return json(item);
      }),
    )
    .then((item) => res.status(201).json(item))
    .catch(next);
});
router.put("/products/:id", manage, (req, res, next) => {
  const data = productData(req.body);
  // Stock has its own auditable workflow. Specs cannot overwrite a recent dispatch.
  if (req.body.quantity !== undefined)
    fail("Change quantities through Post Movement, not item specifications.");
  branchScope(req, req.body.branchId)
    .then((branchId) =>
      transaction((session) => {
        return Product.findOne({
          _id: req.params.id,
          branchId,
          archived: false,
        })
          .session(session)
          .then(async (item) => {
            if (!item) fail("Item not found.", 404);
            if (data.unitOfMeasure !== item.unitOfMeasure)
              fail(
                "Unit of measure cannot change after registration. Register a new SKU for a different unit.",
              );
            if (item.unitCost !== data.unitCost) {
              if (!Array.isArray(item.priceHistory)) item.priceHistory = [];
              item.priceHistory.push({
                cost: data.unitCost,
                date: new Date(),
                supplier: data.supplier,
                note: "Unit cost updated",
              });
            }
            Object.assign(item, data, await productDirectoryReferences(data, session));
            return item.save({ session });
          })
          .then((item) =>
            recordMovement(
              item,
              0,
              {
                movementType: "DETAILS",
                reason: "Item specifications updated",
              },
              req.user,
              session,
            ).then(() => json(item)),
          );
      }),
    )
    .then((item) => res.json(item))
    .catch(next);
});
router.patch("/products/:id/stock", manage, (req, res, next) => {
  if (!["number", "string"].includes(typeof req.body.delta)) {
    fail("Stock change must be a number.");
  }
  if (typeof req.body.delta === "string" && !/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(req.body.delta.trim()))
    fail("Stock change must be a number without letters or symbols.");
  const delta = Number(req.body.delta);
  if (!Number.isFinite(delta) || delta === 0 || Math.abs(delta) > 100000000)
    fail("Stock change must be a non-zero number.");
  const reason = text(req.body.reason, "Reason");
  const referenceNumber = text(
    req.body.referenceNumber ?? req.body.workOrderId ?? "",
    "Reference number",
    false,
  );
  const allowed =
    delta > 0
      ? [
          "Supplier Delivery / Restock",
          "Unused Material Return",
          "Defective / RMA Replacement Return",
          "Audit Correction (Surplus)",
        ]
      : [
          "Client Installation / Site Project",
          "Parts Sale",
          "Damaged / Defective Write-off",
          "Audit Correction (Shortage)",
        ];
  if (!allowed.includes(reason))
    fail("Choose a valid reason for this movement direction.");
  const notes = text(
    req.body.notes,
    "Receipt, return, or adjustment explanation",
  );
  const movementType = delta > 0 ? "STOCK_IN" : "STOCK_OUT";
  if (req.body.referenceId !== undefined &&
      (typeof req.body.referenceId !== "string" || !/^(STI|STO)\d{4,}$/.test(req.body.referenceId)))
    fail("Invalid movement ticket.");
  branchScope(req, req.body.branchId)
    .then(async (branchId) => {
      const ticket = req.body.referenceId === undefined
        ? await reserveMovementTicket(movementType, String(req.user._id))
        : await MovementTicket.findById(req.body.referenceId);
      if (!ticket || ticket.movementType !== movementType) fail("Movement ticket does not match this operation.");
      if (ticket.requestedBy !== String(req.user._id)) fail("This movement ticket belongs to another account.", 403);
      return transaction(async (session) => {
        const reserved = await MovementTicket.findOneAndUpdate(
          { _id: ticket._id, usedAt: { $exists: false } },
          { $set: { usedAt: new Date() } },
          { new: true, session },
        );
        if (!reserved) fail("This movement ticket has already been posted.", 409);
        return changeStock(
          req.params.id,
          branchId,
          delta,
          {
            movementType,
            reason: `${reason}: ${notes}`,
            referenceNumber: referenceNumber || "",
            referenceId: ticket._id,
          },
          req.user,
          session,
        ).then(json);
      });
    })
    .then((item) => res.json(item))
    .catch(next);
});
// Employees record materials consumed from their assigned service van.
router.post("/service-vans/:vanId/usage-ticket", (req, res, next) => {
  branchScope(req, req.params.vanId)
    .then((branchId) => reserveMovementTicket("JOB_CONSUMPTION", String(req.user._id), branchId))
    .then((ticket) => res.status(201).json({ usageId: ticket._id }))
    .catch(next);
});
router.post("/service-vans/:vanId/consume", (req, res, next) => {
  const quantity = number(req.body.quantity, "Quantity used");
  if (!quantity) fail("Quantity used must be positive.");
  if (req.body.usageId !== undefined &&
      (typeof req.body.usageId !== "string" || !/^USE\d{4,}$/.test(req.body.usageId)))
    fail("Invalid generated usage ID.");
  const jobId = req.body.jobId ?? req.body.jobOrderId;
  if (!mongoose.isValidObjectId(jobId)) fail("A current job must be assigned by your admin or manager.");
  const notes = text(req.body.notes, "Notes");

  branchScope(req, req.params.vanId)
    .then(async (branchId) => {
      const ticket = req.body.usageId === undefined
        ? await reserveMovementTicket("JOB_CONSUMPTION", String(req.user._id), branchId)
        : await MovementTicket.findById(req.body.usageId);
      if (!ticket || ticket.movementType !== "JOB_CONSUMPTION" || ticket.branchId !== branchId)
        fail("Usage ID does not match this service vehicle.");
      if (ticket.requestedBy !== String(req.user._id)) fail("This usage ID belongs to another account.", 403);
      return transaction(async (session) => {
        const jobFilter = { _id: jobId, vanId: branchId, status: "OPEN", isCurrent: true };
        if (req.user.role === "EMPLOYEE") jobFilter.assignedTechnicianId = req.user._id;
        const job = await JobOrder.findOneAndUpdate(jobFilter, { $inc: { __v: 1 } }, { new: true, session });
        if (!job) fail("This is no longer your current job. Ask your admin or manager to confirm the assignment.", 409);
        const reserved = await MovementTicket.findOneAndUpdate(
          { _id: ticket._id, usedAt: { $exists: false } },
          { $set: { usedAt: new Date() } }, { new: true, session },
        );
        if (!reserved) fail("This usage ID has already been recorded.", 409);
        return changeStock(
          req.body.productId,
          branchId,
          -quantity,
          {
            movementType: "JOB_CONSUMPTION",
            reason: `Client Installation / Site Project: ${notes}`,
            jobNumber: job.jobNumber,
            jobId: job._id,
            referenceId: ticket._id,
          },
          req.user,
          session,
        ).then(json);
      });
    })
    .then((item) => res.json(item))
    .catch(next);
});
router.delete("/products/:id", manage, (req, res, next) => {
  branchScope(req, req.query.branchId)
    .then((branchId) =>
      transaction((session) => {
        let item;
        return Product.findOne({
          _id: req.params.id,
          branchId,
          archived: false,
        })
          .session(session)
          .then((found) => {
            if (!found) fail("Item not found.", 404);
            item = found;
            if (item.quantity !== 0)
              fail(
                "Issue, transfer, or write off remaining stock before archiving.",
                409,
              );
            return PartRequest.countDocuments({
              productId: item._id,
              status: { $in: ["PENDING", "APPROVED"] },
              deletedAt: { $exists: false },
            }).session(session);
          })
          .then((count) => {
            if (count)
              fail("Resolve open material requests before archiving.", 409);
            item.archived = true;
            return item.save({ session });
          })
          .then(() =>
            recordMovement(
              item,
              0,
              { movementType: "ARCHIVE", reason: "Zero-stock item archived" },
              req.user,
              session,
            ),
          );
      }),
    )
    .then(() => res.json({ success: true }))
    .catch(next);
});
router.post("/products/:id/restore", manage, (req, res, next) => {
  branchScope(req, req.body.branchId)
    .then((branchId) =>
      transaction((session) => {
        return Product.findOneAndUpdate(
          { _id: req.params.id, branchId, archived: true },
          { $set: { archived: false } },
          { new: true, session },
        ).then((item) => {
          if (!item) fail("Archived item not found.", 404);
          return recordMovement(
            item,
            0,
            { movementType: "RESTORE", reason: "Item restored to catalog" },
            req.user,
            session,
          ).then(() => json(item));
        });
      }),
    )
    .then((item) => res.json(item))
    .catch(next);
});
// Transfers between the fixed warehouse and a service vehicle allow managers.
router.post("/transfers", manage, (req, res, next) => {
  if (req.user.role !== "ADMIN" && !req.body.isVanTransfer && !req.body.destinationId?.startsWith("VAN") && !req.body.branchId?.startsWith("VAN")) {
    return res.status(403).json({ error: "Administrator access required." });
  }
  const quantity = number(req.body.quantity, "Transfer quantity");
  if (!quantity) fail("Transfer quantity must be positive.");
  const destinationId = text(req.body.destinationId, "Destination");
  const reason = text(req.body.reason, "Transfer receipt/reference");
  const referenceId = randomUUID();
  branchScope(req, req.body.branchId)
    .then((branchId) => {
      if (branchId === destinationId)
        fail("Choose a different destination branch.");
      return Promise.all([
        branchId === "LOCAL-WAREHOUSE"
          ? Promise.resolve({})
          : ServiceVan.findById(branchId),
        destinationId === "LOCAL-WAREHOUSE"
          ? Promise.resolve({})
          : ServiceVan.findById(destinationId),
      ]).then(([sourceVan, destination]) => {
        if (!destination) fail("Destination service vehicle not found.", 404);
        if (
          branchId !== "LOCAL-WAREHOUSE" &&
          sourceVan?.status === "ON_FIELD" &&
          !req.body.overrideOnField
        ) {
          fail(
            "This vehicle is currently on field. Mark the transfer as an emergency override before unloading it.",
            409,
          );
        }
        if (
          branchId !== "LOCAL-WAREHOUSE" &&
          sourceVan?.status === "ON_FIELD" &&
          req.body.overrideOnField &&
          !/^Emergency:/i.test(reason)
        ) {
          fail("Emergency unloads must include a reason starting with \"Emergency:\".");
        }
        const isVanTransfer =
          branchId !== "LOCAL-WAREHOUSE" || destinationId !== "LOCAL-WAREHOUSE";
        const isVehicleReturn = branchId !== "LOCAL-WAREHOUSE" && destinationId === "LOCAL-WAREHOUSE";
        if (!isVanTransfer && req.user.role !== "ADMIN") {
          return res
            .status(403)
            .json({ error: "Administrator access required." });
        }
        return transaction((session) => {
          let source;
          return changeStock(
            req.body.productId,
            branchId,
            -quantity,
            {
              movementType: "TRANSFER_OUT",
              isVehicleReturn,
              reason,
              referenceId,
            },
            req.user,
            session,
          )
            .then((item) => {
              source = item;
              return Product.findOne({
                branchId: destinationId,
                sku: source.sku,
              }).session(session);
            })
            .then((target) => {
              if (target) {
                if (
                  target.archived ||
                  target.unitOfMeasure !== source.unitOfMeasure ||
                  target.itemType !== source.itemType ||
                  target.name !== source.name ||
                  target.brand !== source.brand ||
                  target.capacity !== source.capacity
                ) {
                  fail(
                    "Destination SKU is archived or its item details differ. Resolve the catalog mismatch first.",
                    409,
                  );
                }
                return target;
              }
              return Product.create(
                [
                  {
                    ...productData(source),
                    brandId: source.brandId,
                    supplierId: source.supplierId,
                    sku: source.sku,
                    branchId: destinationId,
                    quantity: 0,
                  },
                ],
                { session },
              ).then(([created]) => created);
            })
            .then((target) =>
              changeStock(
                target._id,
                destinationId,
                quantity,
                {
                  movementType: "TRANSFER_IN",
                  isVehicleReturn,
                  reason,
                  referenceId,
                },
                req.user,
                session,
              ),
            );
        });
      });
    })
    .then(() => res.status(201).json({ referenceId }))
    .catch(next);
});
router.get("/movements", (req, res, next) => {
  const scope = req.query.scope || "all";
  if (!["all", "branch"].includes(scope)) fail("Choose a valid movement scope.");
  const page = Math.max(1, Math.floor(Number(req.query.page) || 1));
  const pageSize = Math.min(
    100,
    Math.max(1, Math.floor(Number(req.query.pageSize) || 15)),
  );
  const sortBy = String(req.query.sort || "newest");
  const sort = {
    newest: { createdAt: -1, _id: -1 },
    oldest: { createdAt: 1, _id: 1 },
    az: { itemName: 1, sku: 1, createdAt: -1, _id: -1 },
    za: { itemName: -1, sku: -1, createdAt: -1, _id: -1 },
  }[sortBy] || { createdAt: -1, _id: -1 };
  branchScope(req, req.query.branchId)
    .then((branchId) => {
      const scopeIds = [branchId];
      if (branchId === "LOCAL-WAREHOUSE" && scope === "all") {
        return ServiceVan.find({
          ...(req.user.role === "EMPLOYEE"
            ? {
                $or: [
                  { driverId: String(req.user._id) },
                  { driverName: req.user.fullName },
                  { driverName: `${req.user.fullName} (${req.user.role})` },
                ],
              }
            : {}),
        }).then((assignedVans) => {
          assignedVans.forEach((van) => scopeIds.push(van._id));
          return scopeIds;
        });
      }
      return scopeIds;
    })
    .then((scopeIds) => {
      const filter = { branchId: scopeIds.length === 1 ? scopeIds[0] : { $in: scopeIds } };
      if (req.query.type === "RETURNED") {
        filter.movementType = { $in: ["TRANSFER_IN", "TRANSFER_OUT"] };
        filter.$and = [{ $or: [
          { isVehicleReturn: true },
          { isVehicleReturn: { $exists: false }, reason: /^(Emergency:\s*)?Van Return to Warehouse(?:\s|$)/i },
        ] }];
      } else if (req.query.type) {
        filter.movementType = text(req.query.type, "Movement type");
      }
      if (req.query.search) {
        const search = text(req.query.search, "Search").replace(
          /[.*+?^${}()|[\]\\]/g,
          "\\$&",
        );
        filter.$or = [
          "sku",
          "itemName",
          "brand",
          "itemType",
          "category",
          "reason",
          "referenceNumber",
          "jobNumber",
          "performedByName",
          "referenceId",
          "transferNumber",
          "vehicleReceiptNumber",
          "requestNumber",
        ].map((field) => ({ [field]: { $regex: search, $options: "i" } }));
      }
      return Promise.all([
        Movement.find(filter)
          .sort(sort)
          .skip((page - 1) * pageSize)
          .limit(pageSize)
          .populate("productId", "brand itemType category"),
        Movement.countDocuments(filter),
      ]);
    })
    .then(([items, total]) =>
      res.json({ items: items.map(inventoryRecordJson), total, page, pageSize }),
    )
    .catch(next);
});
router.get("/analytics", (req, res, next) => {
  branchScope(req, req.query.branchId)
    .then((branchId) => {
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      return Promise.all([
        Product.find({ branchId, archived: false }),
        Movement.find({
          branchId,
          createdAt: { $gte: thirtyDaysAgo },
          quantityDelta: { $lt: 0 },
        }),
      ]);
    })
    .then(([products, movements]) => {
      const consumption = {};
      movements.forEach((m) => {
        const sku = (m.sku || "").toUpperCase();
        consumption[sku] = (consumption[sku] || 0) + Math.abs(m.quantityDelta || 0);
      });
      const scored = products.map((p) => ({
        id: p._id,
        sku: p.sku,
        name: p.name,
        category: p.category,
        itemType: p.itemType,
        quantity: p.quantity,
        unitOfMeasure: p.unitOfMeasure,
        dispatched30d: Math.round((consumption[p.sku.toUpperCase()] || 0) * 1000) / 1000,
      }));
      scored.sort((a, b) => b.dispatched30d - a.dispatched30d);
      const fastMoving = scored.filter((p) => p.dispatched30d > 0).slice(0, 5);
      const slowMoving = scored.filter((p) => p.dispatched30d === 0).slice(0, 5);
      res.json({ fastMoving, slowMoving });
    })
    .catch(next);
});
export default router;
