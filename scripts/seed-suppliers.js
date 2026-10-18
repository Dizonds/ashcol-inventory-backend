import mongoose from "mongoose";
import { Product, Supplier } from "../src/models.js";

async function run() {
  await mongoose.connect(process.env.MONGO_URI || "mongodb://127.0.0.1:27018/ashcol_inventory?replicaSet=rs0");
  const figmaSuppliers = [
    { name: "Carrier Air Conditioning Philippines, Inc.", contactPerson: "Michael Santos", phone: "+63 917 845 2310", email: "msantos@carrierph.com", terms: "Net 30 Days", address: "Pasig City, Metro Manila" },
    { name: "Daikin Philippines Corporation", contactPerson: "Jennifer Lim", phone: "+63 918 334 5621", email: "jlim@daikin.com.ph", terms: "Net 30 Days", address: "Alabang, Muntinlupa City" },
    { name: "Concepcion-Carrier Air Conditioning Co.", contactPerson: "Robert Cruz", phone: "+63 917 622 1845", email: "rcruz@concepcioncarrier.com", terms: "Net 30 Days", address: "Balintawak, Quezon City" },
    { name: "LG Electronics Philippines Inc.", contactPerson: "Daniel Reyes", phone: "+63 919 776 9502", email: "dreyes@lge.com", terms: "Cash on Delivery", address: "Taguig City, Metro Manila" },
    { name: "Mitsubishi Electric Asia Pte. Ltd. (PH Representative)", contactPerson: "Karen Velasco", phone: "+63 917 558 7720", email: "kvelasco@mitsubishielectric.com", terms: "Net 60 Days", address: "Makati City, Metro Manila" },
    { name: "CoolSource HVAC Trading", contactPerson: "Anthony Dela Torre", phone: "+63 918 923 4115", email: "sales@coolsourcehvac.ph", terms: "Net 15 Days", address: "Dasma, Cavite" },
    { name: "Panasonic Manufacturing Philippines Corp.", contactPerson: "Eduardo Ramos", phone: "+63 917 332 9981", email: "eramos@panasonic.com.ph", terms: "Net 30 Days", address: "Taytay, Rizal" },
    { name: "Koppel, Inc.", contactPerson: "Maricel Tan", phone: "+63 918 445 7712", email: "mtan@koppel.ph", terms: "Net 30 Days", address: "Paranaque City, Metro Manila" },
    { name: "Gree Philippines Distribution", contactPerson: "Raymond Bautista", phone: "+63 919 556 1234", email: "sales@gree.ph", terms: "Cash on Delivery", address: "Quezon City, Metro Manila" },
    { name: "Midea HVAC Solutions Philippines", contactPerson: "Katrina Gonzaga", phone: "+63 917 667 8901", email: "kgonzaga@midea.com.ph", terms: "Net 45 Days", address: "Mandaluyong City, Metro Manila" },
    { name: "TCL Air Conditioner Philippines", contactPerson: "Patrick David", phone: "+63 918 778 4567", email: "pdavid@tcl.com.ph", terms: "Net 30 Days", address: "BGC, Taguig City" },
    { name: "Samsung Electronics Philippines", contactPerson: "Christine Flores", phone: "+63 917 889 0123", email: "cflores@samsung.com.ph", terms: "Net 60 Days", address: "Taguig City, Metro Manila" }
  ];

  for (const s of figmaSuppliers) {
    await Supplier.findOneAndUpdate(
      { name: s.name },
      { $set: s },
      { upsert: true }
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
