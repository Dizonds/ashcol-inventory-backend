import "dotenv/config";
import mongoose from "mongoose";
import { Product, Movement, Branch } from "../src/models.js";
import { productData, checkQuantity, number } from "../src/helpers.js";

// Explicit, all-or-nothing migration. No database migration runs automatically.
const branchId = process.argv[2];
if (!branchId || !/^[A-Za-z0-9-]+$/.test(branchId)) {
  console.error(
    "Usage: npm run migrate -- BRANCH_ID. Back up the database first.",
  );
  process.exitCode = 1;
} else {
  mongoose
    .connect(
      process.env.MONGO_URI || "mongodb://127.0.0.1:27017/ashcol_inventory",
      { autoIndex: false },
    )
    .then(() =>
      mongoose.connection.transaction((session) => {
        let products;
        return Product.find()
          .session(session)
          .then((items) => {
            products = items;
            const keys = new Set();
            items.forEach((item) => {
              const sku = (item.sku || "").trim().toUpperCase();
              const key = `${item.branchId || branchId}/${sku}`;
              if (!sku || keys.has(key))
                throw new Error(
                  `Missing or duplicate SKU at ${key}. Resolve it manually before migration; nothing has been migrated.`,
                );
              keys.add(key);
              productData(item);
              number(item.quantity, "Quantity");
              checkQuantity(item.quantity, item.unitOfMeasure);
            });
            return Branch.updateOne(
              { _id: branchId },
              {
                $setOnInsert: {
                  name:
                    process.env.LEGACY_BRANCH_NAME ||
                    `${branchId} (imported warehouse)`,
                },
              },
              { upsert: true, session },
            );
          })
          .then(() => {
            // Sequential saves keep transaction behavior easy to inspect.
            return products.reduce(
              (chain, item) =>
                chain.then(() => {
                  return Product.updateOne(
                    { _id: item._id },
                    {
                      $set: {
                        branchId: item.branchId || branchId,
                        sku: item.sku.trim().toUpperCase(),
                        archived: item.archived === true,
                      },
                    },
                    { session },
                  );
                }),
              Promise.resolve(),
            );
          })
          .then(() =>
            Movement.find({ branchId: { $exists: false } }).session(session),
          )
          .then((entries) => {
            return entries.reduce(
              (chain, entry) =>
                chain.then(() => {
                  const sku = (entry.sku || "").trim().toUpperCase();
                  const item = products.filter(
                    (product) =>
                      product.sku.trim().toUpperCase() === sku &&
                      (!product.branchId || product.branchId === branchId),
                  )[0];
                  const fields = { branchId, sku };
                  if (item) {
                    fields.productId = item._id;
                    fields.unitOfMeasure = item.unitOfMeasure;
                  }
                  // Do not invent missing actors or before/after balances for old records.
                  return Movement.updateOne(
                    { _id: entry._id },
                    { $set: fields },
                    { session },
                  );
                }),
              Promise.resolve(),
            );
          });
      }),
    )
    .then(() =>
      console.log(
        "Migration completed. Legacy actors/balances remain marked as unrecorded. Start the server to create indexes.",
      ),
    )
    .catch((error) => {
      console.error("Migration failed:", error.message);
      process.exitCode = 1;
    })
    .finally(() => mongoose.disconnect());
}
