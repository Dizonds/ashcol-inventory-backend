import "dotenv/config";
import mongoose from "mongoose";
import { ServiceVan } from "../src/models.js";

const vehicles = [
  { _id: "VAN-03", name: "Field Service Van Charlie", plateNumber: "DEMO-0003" },
  { _id: "VAN-04", name: "Field Service Van Delta", plateNumber: "DEMO-0004" },
  { _id: "VAN-05", name: "Field Service Van Echo", plateNumber: "DEMO-0005" },
  { _id: "VAN-06", name: "Field Service Van Foxtrot", plateNumber: "DEMO-0006" },
  { _id: "VAN-07", name: "Field Service Van Golf", plateNumber: "DEMO-0007" },
];

async function main() {
  await mongoose.connect(
    process.env.MONGO_URI || "mongodb://127.0.0.1:27017/ashcol_inventory",
    { serverSelectionTimeoutMS: 5000 },
  );

  let added = 0;
  for (const vehicle of vehicles) {
    const result = await ServiceVan.updateOne(
      { _id: vehicle._id },
      {
        $setOnInsert: {
          ...vehicle,
          status: "AVAILABLE",
          driverId: "",
          driverName: "",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      },
      { upsert: true, runValidators: true, timestamps: false },
    );
    added += result.upsertedCount;
  }

  const saved = await ServiceVan.find({ _id: { $in: vehicles.map(({ _id }) => _id) } })
    .select("_id name plateNumber status")
    .sort({ _id: 1 })
    .lean();
  if (saved.length !== vehicles.length) throw new Error("Demo vehicle verification failed.");
  console.log(`Added ${added} demo vehicles; ${vehicles.length - added} already existed.`);
  console.table(saved);
}

main()
  .catch((error) => {
    console.error("Demo vehicle seeding failed:", error.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
