import mongoose from "mongoose";
import { Product, Supplier } from "../src/models.js";

async function run() {
  await mongoose.connect(process.env.MONGO_URI || "mongodb://127.0.0.1:27017/ashcol_inventory");
  const prods = await Product.find();
  const names = Array.from(new Set(prods.map((p) => p.supplier).filter(Boolean)));
  for (const name of names) {
    await Supplier.findOneAndUpdate(
      { name },
      {
        $setOnInsert: {
          name,
          contactPerson: "Corporate Sales Rep",
          phone: "+63 2 8888 0000",
          email: `sales@${name.toLowerCase().replace(/[^a-z0-9]/g, "") || "vendor"}.com.ph`,
          address: "Metro Manila, Philippines",
          terms: "30 Days Net",
        },
      },
      { upsert: true },
    );
  }

  // Also seed compatibility models on the parts
  const compatibilityMap = {
    "FRN-R410A-11.3": ["CAR-1.0HP-CRY", "CAR-1.5HP-INV", "CAR-2.0HP-INV", "KOL-1.0HP-WINV", "GREE-3.0TR-FLR", "TCL-1.0HP-PORT"],
    "FRN-R32-9.5KG": ["DAIK-1.0HP-INV", "PANA-1.5HP-XPU", "MIDEA-5.0TR-FLR"],
    "FRN-R134A-13.6": ["KOL-0.75HP-WND"],
    "COP-1/4-3/8-15M": ["DAIK-1.0HP-INV", "CAR-1.0HP-CRY", "TCL-1.0HP-PORT"],
    "COP-1/4-1/2-15M": ["CAR-1.5HP-INV", "CAR-2.0HP-INV", "PANA-1.5HP-XPU"],
    "CMP-GMCC-1.5HP": ["CAR-1.5HP-INV", "MIDEA-5.0TR-FLR"],
    "CMP-LG-2.0HP-ROT": ["CAR-2.0HP-INV"],
    "MAT-DRAIN-HOSE": ["DAIK-1.0HP-INV", "CAR-1.0HP-CRY", "CAR-1.5HP-INV", "CAR-2.0HP-INV", "PANA-1.5HP-XPU", "GREE-3.0TR-FLR", "MIDEA-5.0TR-FLR", "TCL-1.0HP-PORT"],
    "MAT-WALL-BRKT-L": ["DAIK-1.0HP-INV", "CAR-1.0HP-CRY", "CAR-1.5HP-INV", "CAR-2.0HP-INV", "PANA-1.5HP-XPU"],
    "MAT-CAP-35-5MFD": ["CAR-1.0HP-CRY", "CAR-1.5HP-INV", "KOL-0.75HP-WND", "KOL-1.0HP-WINV"],
  };

  for (const [sku, models] of Object.entries(compatibilityMap)) {
    await Product.updateMany({ sku }, { $set: { compatibleModels: models } });
  }

  console.log("Suppliers and compatibility models seeded successfully.");
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
