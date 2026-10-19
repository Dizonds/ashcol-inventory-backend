import mongoose from "mongoose";
import {
  ServiceVan,
  Brand,
  Product,
  Movement,
  User,
  Session,
  PartRequest,
  RequestReference,
  Counter,
  MovementTicket,
  JobOrder,
} from "./models.js";
import { assignExistingRequestNumbers } from "../services/numbering/request-numbers.js";
import { assignExistingTransferNumbers } from "../services/numbering/transfer-numbers.js";

export function initializeDatabase() {
  return mongoose.connection.db
    .admin()
    .command({ hello: 1 })
    .then((hello) => {
      if (!hello.setName && hello.msg !== "isdbgrid")
        throw new Error(
          "Stock transactions require MongoDB Atlas or a replica set. See docs/SETUP.md.",
        );
      return Promise.all([
        Product.countDocuments({ branchId: { $exists: false } }),
        Movement.countDocuments({ branchId: { $exists: false } }),
      ]);
    })
    .then(([legacyCount, legacyMovements]) => {
      if (legacyCount || legacyMovements)
        throw new Error(
          "Legacy inventory needs a branch assignment. Back up the database and run npm run migrate -- BRANCH_ID. See docs/SETUP.md.",
        );
      return Promise.all(
        [Product, Movement, ServiceVan, Brand, User, Session, PartRequest, RequestReference, Counter, MovementTicket, JobOrder].map(
          (model) => model.createIndexes(),
        ),
      );
    })
    .then(() => assignExistingRequestNumbers())
    .then(() => assignExistingTransferNumbers())
    .then(() => Brand.countDocuments())
    .then((count) => {
      if (count === 0)
        return Brand.insertMany(
          [
            "Carrier", "Daikin", "Panasonic", "LG", "Kolin", "Samsung",
            "Mitsubishi", "Midea", "Gree", "TCL", "Generic Parts", "Armacell", "Kembla",
          ].map((name) => ({ name })),
        );
    });
}
