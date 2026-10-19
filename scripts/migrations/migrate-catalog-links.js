import "dotenv/config";
import mongoose from "mongoose";

const uri = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/ashcol_inventory?replicaSet=rs0";
const apply = process.argv.includes("--apply");
const normalize = (value) => String(value || "").trim().toLocaleLowerCase("en");

async function main() {
  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  const products = db.collection("products");
  const brands = await db.collection("brands").find({}, { projection: { name: 1 } }).toArray();
  const suppliers = await db.collection("suppliers").find({}, { projection: { name: 1 } }).toArray();
  const brandIds = new Map(brands.map((entry) => [normalize(entry.name), entry._id]));
  const supplierIds = new Map(suppliers.map((entry) => [normalize(entry.name), entry._id]));
  const rows = await products.find({}).toArray();
  const operations = [];
  let brandLinks = 0;
  let supplierLinks = 0;

  for (const product of rows) {
    const set = {};
    const brandId = brandIds.get(normalize(product.brand));
    const supplierId = supplierIds.get(normalize(product.supplier));
    if (!product.brandId && brandId) { set.brandId = brandId; brandLinks += 1; }
    if (!product.supplierId && supplierId) { set.supplierId = supplierId; supplierLinks += 1; }
    if (Object.keys(set).length) operations.push({ updateOne: { filter: { _id: product._id }, update: { $set: set } } });
  }

  console.log(`Found ${rows.length} product(s); ${brandLinks} can link to brands and ${supplierLinks} can link to suppliers.`);
  if (!apply) {
    console.log("Dry run only. Back up the database, then rerun with --apply to add optional lookup references.");
    return;
  }
  if (operations.length) await products.bulkWrite(operations, { ordered: true });
  const linked = await Promise.all([
    products.countDocuments({ brandId: { $exists: true, $ne: null } }),
    products.countDocuments({ supplierId: { $exists: true, $ne: null } }),
  ]);
  console.log(`Migration complete. Products with brandId: ${linked[0]}; products with supplierId: ${linked[1]}.`);
}

main()
  .catch((error) => { console.error("Catalog-link migration failed:", error.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect());
