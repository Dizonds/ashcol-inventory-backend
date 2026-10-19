import "dotenv/config";
import mongoose from "mongoose";

const uri = process.env.MONGO_URI || "mongodb://127.0.0.1:27018/ashcol_inventory?replicaSet=rs0";
const dbName = new URL(uri).pathname.replace(/^\//, "") || "ashcol_inventory";
const allowExtraWarehouses = process.argv.includes("--drop-extra-warehouses");

async function main() {
  await mongoose.connect(uri, { dbName });
  const db = mongoose.connection.db;
  const collections = await db.listCollections().toArray();
  const hasBranches = collections.some(({ name }) => name === "branches");
  if (!hasBranches) {
    console.log("No branches collection found; nothing to migrate.");
    return;
  }

  const legacy = await db.collection("branches").find({}).toArray();
  const nonVans = legacy.filter((item) => item.branchType !== "SERVICE_VAN");
  const unexpected = nonVans.filter((item) => String(item._id) !== "LOCAL-WAREHOUSE");
  if (unexpected.length && !allowExtraWarehouses) {
    throw new Error(
      `Refusing to delete branches: found ${unexpected.length} non-Taguig warehouse records. Review them or rerun with --drop-extra-warehouses.`,
    );
  }
  if (unexpected.length)
    console.warn(`Dropping ${unexpected.length} extra warehouse record(s): ${unexpected.map((item) => item._id).join(", ")}`);

  const vans = legacy.filter((item) => item.branchType === "SERVICE_VAN");
  const target = db.collection("service_vans");
  for (const van of vans) {
    await target.replaceOne(
      { _id: van._id },
      {
        _id: van._id,
        name: van.name,
        plateNumber: van.plateNumber || "",
        driverId: van.driverId || "",
        driverName: van.driverName || "",
        status: van.status || "AVAILABLE",
        createdAt: van.createdAt,
        updatedAt: van.updatedAt,
      },
      { upsert: true },
    );
  }

  const migratedCount = await target.countDocuments({ _id: { $in: vans.map((van) => van._id) } });
  if (migratedCount !== vans.length) {
    throw new Error(`Migration verification failed: copied ${migratedCount}/${vans.length} service vehicles.`);
  }

  await db.collection("branches").drop();
  console.log(`Migrated ${vans.length} service vehicles and dropped the branches collection.`);
}

main()
  .catch((error) => {
    console.error("Service-vehicle migration failed:", error.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
