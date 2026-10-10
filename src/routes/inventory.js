import { Router } from "express";
import { randomUUID } from "node:crypto";
import { Product, Movement, Branch, PartRequest } from "../models.js";
import { manage, admin } from "../auth.js";
import {
  branchScope,
  productData,
  number,
  text,
  fail,
  json,
  checkQuantity,
  transaction,
  recordMovement,
  changeStock,
  generateTicket,
} from "../helpers.js";

const router = Router();
router.get("/products", (req, res, next) => {
  branchScope(req, req.query.branchId)
    .then((branchId) =>
      Promise.all([
        Product.find({ branchId, archived: req.query.archived === "true" }).sort({
          name: 1,
        }),
        PartRequest.find({ branchId, status: "APPROVED" }),
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
        const reserved = reservedMap[itemObj.id] || 0;
        itemObj.reservedQuantity = reserved;
        itemObj.availableQuantity =
          Math.max(0, Math.round((itemObj.quantity - reserved) * 1000) / 1000);
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
      transaction((session) => {
        return Product.create([{ ...data, branchId }], { session }).then(
          ([item]) => {
            return recordMovement(
              item,
              item.quantity,
              { movementType: "OPENING", reason: "Initial opening stock" },
              req.user,
              session,
            ).then(() => json(item));
          },
        );
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
          .then((item) => {
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
            Object.assign(item, data);
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
  const delta = Number(req.body.delta);
  if (!Number.isFinite(delta) || delta === 0 || Math.abs(delta) > 100000000)
    fail("Stock change must be a non-zero number.");
  const reason = text(req.body.reason, "Reason");
  const workOrderId = text(
    req.body.workOrderId || "",
    "Job/reference number",
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
  const referenceId = generateTicket(delta > 0 ? "STI" : "STO");
  branchScope(req, req.body.branchId)
    .then((branchId) =>
      transaction((session) => {
        return changeStock(
          req.params.id,
          branchId,
          delta,
          {
            movementType,
            reason: `${reason}: ${notes}`,
            workOrderId: workOrderId || "",
            referenceId,
          },
          req.user,
          session,
        ).then(json);
      }),
    )
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
// Transfers between two branches require admin; loading to or returning from a service van allows managers
router.post("/transfers", manage, (req, res, next) => {
  if (req.user.role !== "ADMIN" && !req.body.isVanTransfer && !req.body.destinationId?.startsWith("VAN") && !req.body.branchId?.startsWith("VAN")) {
    return res.status(403).json({ error: "Administrator access required." });
  }
  const quantity = number(req.body.quantity, "Transfer quantity");
  if (!quantity) fail("Transfer quantity must be positive.");
  const destinationId = text(req.body.destinationId, "Destination");
  const reason = text(req.body.reason, "Transfer receipt/reference");
  const referenceId = generateTicket("TRA");
  branchScope(req, req.body.branchId)
    .then((branchId) => {
      if (branchId === destinationId)
        fail("Choose a different destination branch.");
      return Promise.all([
        Branch.findById(branchId),
        Branch.findById(destinationId),
      ]).then(([sourceBranch, destination]) => {
        if (!destination) fail("Destination branch not found.", 404);
        const isVanTransfer =
          (sourceBranch && sourceBranch.branchType === "SERVICE_VAN") ||
          destination.branchType === "SERVICE_VAN";
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
  const page = Math.max(1, Math.floor(Number(req.query.page) || 1));
  const pageSize = Math.min(
    100,
    Math.max(1, Math.floor(Number(req.query.pageSize) || 15)),
  );
  branchScope(req, req.query.branchId)
    .then((branchId) => {
      const filter = { branchId };
      if (req.query.type)
        filter.movementType = text(req.query.type, "Movement type");
      if (req.query.search) {
        const search = text(req.query.search, "Search").replace(
          /[.*+?^${}()|[\]\\]/g,
          "\\$&",
        );
        filter.$or = [
          "sku",
          "itemName",
          "reason",
          "workOrderId",
          "performedByName",
          "referenceId",
        ].map((field) => ({ [field]: { $regex: search, $options: "i" } }));
      }
      return Promise.all([
        Movement.find(filter)
          .sort({ createdAt: -1, _id: -1 })
          .skip((page - 1) * pageSize)
          .limit(pageSize),
        Movement.countDocuments(filter),
      ]);
    })
    .then(([items, total]) =>
      res.json({ items: items.map(json), total, page, pageSize }),
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
