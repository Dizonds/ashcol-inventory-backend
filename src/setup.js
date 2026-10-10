import mongoose from "mongoose";
import {
  Branch,
  Brand,
  Product,
  Movement,
  User,
  Session,
  PartRequest,
} from "./models.js";

export function initializeDatabase() {
  return mongoose.connection.db
    .admin()
    .command({ hello: 1 })
    .then((hello) => {
      if (!hello.setName && hello.msg !== "isdbgrid")
        throw new Error(
          "Stock transactions require MongoDB Atlas or a replica set. See SETUP.md.",
        );
      return Promise.all([
        Product.countDocuments({ branchId: { $exists: false } }),
        Movement.countDocuments({ branchId: { $exists: false } }),
      ]);
    })
    .then(([legacyCount, legacyMovements]) => {
      if (legacyCount || legacyMovements)
        throw new Error(
          "Legacy inventory needs a branch assignment. Back up the database and run npm run migrate -- BRANCH_ID. See SETUP.md.",
        );
      return Promise.all(
        [Product, Movement, Branch, Brand, User, Session, PartRequest].map(
          (model) => model.createIndexes(),
        ),
      );
    })
    .then(() => Branch.countDocuments())
    .then((count) => {
      // Local identifiers, not claims about production portal IDs.
      if (count === 0)
        return Branch.create({
          _id: "LOCAL-WAREHOUSE",
          name: "Main Warehouse (local)",
        });
    })
    .then(() => Brand.countDocuments())
    .then((count) => {
      if (count === 0)
        return Brand.insertMany(
          [
            "Carrier",
            "Daikin",
            "Panasonic",
            "LG",
            "Kolin",
            "Samsung",
            "Mitsubishi",
            "Midea",
            "Gree",
            "TCL",
            "Generic Parts",
          ].map((name) => ({ name })),
        );
    });
}
