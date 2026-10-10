import mongoose from "mongoose";
import { hashPassword } from "../src/auth.js";
import {
  Product,
  Movement,
  Branch,
  Brand,
  Supplier,
  User,
  Session,
  PartRequest,
} from "../src/models.js";

async function resetAndSeed() {
  await mongoose.connect(
    process.env.MONGO_URI || "mongodb://127.0.0.1:27017/ashcol_inventory",
  );
  console.log("Connected to MongoDB. Resetting inventory collections...");

  // 1. Clear inventory collections
  await Promise.all([
    Product.deleteMany({}),
    Movement.deleteMany({}),
    Branch.deleteMany({}),
    Brand.deleteMany({}),
    Supplier.deleteMany({}),
    User.deleteMany({}),
    Session.deleteMany({}),
    PartRequest.deleteMany({}),
  ]);
  console.log("Cleared existing inventory collections.");

  // 2. Seed Brands
  const brandNames = [
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
    "Armacell",
    "Kembla",
  ];
  await Brand.insertMany(brandNames.map((name) => ({ name })));
  console.log(`Seeded ${brandNames.length} brands.`);

  // 3. Seed Branches & Service Vans
  const branches = [
    {
      _id: "LOCAL-WAREHOUSE",
      name: "Main Taguig Warehouse",
      branchType: "WAREHOUSE",
      status: "AVAILABLE",
    },
    {
      _id: "BRANCH-NORTH",
      name: "Quezon City Service Hub",
      branchType: "WAREHOUSE",
      status: "AVAILABLE",
    },
    {
      _id: "VAN-01",
      name: "Field Service Van Alpha",
      branchType: "SERVICE_VAN",
      plateNumber: "NBD-1234",
      driverName: "Alex Rivera (Lead Tech)",
      status: "AVAILABLE",
    },
    {
      _id: "VAN-02",
      name: "Field Service Van Bravo",
      branchType: "SERVICE_VAN",
      plateNumber: "ABC-5678",
      driverName: "Danilo Santos (Senior Tech)",
      status: "ON_FIELD",
    },
  ];
  await Branch.insertMany(branches);
  console.log(`Seeded ${branches.length} facilities/vans.`);

  // 4. Seed Suppliers
  const suppliers = [
    {
      name: "Concepcion-Carrier Air Conditioning Co.",
      contactPerson: "Eduardo Santos",
      phone: "+63 2 8863 5555",
      email: "corporate.sales@ccac.com.ph",
      address: "Km 20 East Service Road, South Superhighway, Muntinlupa",
      terms: "30 Days Net",
    },
    {
      name: "Daikin Airconditioning Phils Inc.",
      contactPerson: "Maria Teresa Reyes",
      phone: "+63 2 8370 2828",
      email: "dealer.inquiry@daikin.com.ph",
      address: "BGC, Taguig City, Metro Manila",
      terms: "30 Days Net",
    },
    {
      name: "Panasonic Manufacturing Phils.",
      contactPerson: "Roberto Gomez",
      phone: "+63 2 8635 2260",
      email: "hvac.solutions@panasonic.com.ph",
      address: "Taytay, Rizal",
      terms: "45 Days Net",
    },
    {
      name: "Chemours Specialty Chemicals",
      contactPerson: "Analyn Cruz",
      phone: "+63 2 8894 1120",
      email: "freon.orders@chemours.com",
      address: "Makati City, Metro Manila",
      terms: "COD / 15 Days",
    },
    {
      name: "Kembla Copper Tube Phils.",
      contactPerson: "Fernando Lim",
      phone: "+63 2 8361 7788",
      email: "tubing.sales@kembla.com.ph",
      address: "Caloocan City, Metro Manila",
      terms: "30 Days Net",
    },
    {
      name: "Apex HVAC Components & Metal Fabrication",
      contactPerson: "Michael Tan",
      phone: "+63 2 8282 3344",
      email: "orders@apexmetal.ph",
      address: "Valenzuela City, Metro Manila",
      terms: "COD",
    },
  ];
  await Supplier.insertMany(suppliers);
  console.log(`Seeded ${suppliers.length} suppliers.`);

  // 5. Seed Users (Admin, Manager, Employee)
  const passwordHash = await hashPassword("hatdog@hat.com");
  const users = [
    {
      email: "hatdog@hat.com",
      fullName: "Admin Master (Hatdog)",
      role: "ADMIN",
      branchId: "LOCAL-WAREHOUSE",
      passwordHash,
    },
    {
      email: "manager@ashcol.com",
      fullName: "Warehouse Manager",
      role: "MANAGER",
      branchId: "LOCAL-WAREHOUSE",
      passwordHash,
    },
    {
      email: "technician@ashcol.com",
      fullName: "Field Technician Lead",
      role: "EMPLOYEE",
      branchId: "LOCAL-WAREHOUSE",
      passwordHash,
    },
  ];
  await User.insertMany(users);
  console.log(`Seeded ${users.length} user accounts.`);

  // 6. Comprehensive Product Catalog
  const products = [
    // --- 1. AC UNITS ---
    {
      branchId: "LOCAL-WAREHOUSE",
      sku: "CAR-1.0HP-CRY",
      name: "Carrier Crystal Inverter Split System",
      itemType: "AC Unit",
      category: "Split Type",
      brand: "Carrier",
      capacity: "1.0 HP / 9,500 BTU",
      unitOfMeasure: "UNIT",
      unitCost: 21500,
      listPrice: 28900,
      quantity: 12,
      reorderLevel: 3,
      supplier: "Concepcion-Carrier Air Conditioning Co.",
      priceHistory: [{ cost: 21500, note: "Initial stock intake" }],
    },
    {
      branchId: "LOCAL-WAREHOUSE",
      sku: "CAR-1.5HP-INV",
      name: "Carrier Aura Inverter High Wall Split",
      itemType: "AC Unit",
      category: "Split Type",
      brand: "Carrier",
      capacity: "1.5 HP / 12,000 BTU",
      unitOfMeasure: "UNIT",
      unitCost: 26800,
      listPrice: 34500,
      quantity: 8,
      reorderLevel: 2,
      supplier: "Concepcion-Carrier Air Conditioning Co.",
      priceHistory: [{ cost: 26800, note: "Initial stock intake" }],
    },
    {
      branchId: "LOCAL-WAREHOUSE",
      sku: "DAIK-1.0HP-INV",
      name: "Daikin D-Compact Inverter Split AC",
      itemType: "AC Unit",
      category: "Split Type",
      brand: "Daikin",
      capacity: "1.0 HP / 9,000 BTU",
      unitOfMeasure: "UNIT",
      unitCost: 23500,
      listPrice: 30500,
      quantity: 10,
      reorderLevel: 3,
      supplier: "Daikin Airconditioning Phils Inc.",
      priceHistory: [{ cost: 23500, note: "Initial stock intake" }],
    },
    {
      branchId: "LOCAL-WAREHOUSE",
      sku: "PANA-1.5HP-XPU",
      name: "Panasonic Aero Inverter nanoe™ X",
      itemType: "AC Unit",
      category: "Split Type",
      brand: "Panasonic",
      capacity: "1.5 HP / 12,500 BTU",
      unitOfMeasure: "UNIT",
      unitCost: 28200,
      listPrice: 36800,
      quantity: 6,
      reorderLevel: 2,
      supplier: "Panasonic Manufacturing Phils.",
      priceHistory: [{ cost: 28200, note: "Initial stock intake" }],
    },
    {
      branchId: "LOCAL-WAREHOUSE",
      sku: "KOL-1.0HP-WINV",
      name: "Kolin Full DC Inverter Window Type",
      itemType: "AC Unit",
      category: "Window Type",
      brand: "Kolin",
      capacity: "1.0 HP / 9,800 BTU",
      unitOfMeasure: "UNIT",
      unitCost: 17200,
      listPrice: 22400,
      quantity: 14,
      reorderLevel: 4,
      supplier: "Concepcion-Carrier Air Conditioning Co.",
      priceHistory: [{ cost: 17200, note: "Initial stock intake" }],
    },
    {
      branchId: "LOCAL-WAREHOUSE",
      sku: "GREE-3.0TR-FLR",
      name: "Gree Commercial Floor Mounted Package AC",
      itemType: "AC Unit",
      category: "Floor Mounted",
      brand: "Gree",
      capacity: "3.0 TR / 36,000 BTU",
      unitOfMeasure: "UNIT",
      unitCost: 68000,
      listPrice: 84500,
      quantity: 3,
      reorderLevel: 1,
      supplier: "Concepcion-Carrier Air Conditioning Co.",
      priceHistory: [{ cost: 68000, note: "Initial stock intake" }],
    },

    // --- 2. SPARE PARTS ---
    {
      branchId: "LOCAL-WAREHOUSE",
      sku: "CMP-GMCC-1.5HP",
      name: "GMCC Rotary Inverter Compressor 1.5 HP",
      itemType: "Spare Part",
      category: "Compressors",
      brand: "Midea",
      capacity: "1.5 HP (R410A / R32)",
      unitOfMeasure: "UNIT",
      unitCost: 6800,
      listPrice: 9400,
      quantity: 5,
      reorderLevel: 2,
      supplier: "Concepcion-Carrier Air Conditioning Co.",
      compatibleModels: ["CAR-1.5HP-INV", "DAIK-1.0HP-INV"],
      priceHistory: [{ cost: 6800, note: "Initial stock intake" }],
    },
    {
      branchId: "LOCAL-WAREHOUSE",
      sku: "MAT-CAP-35-5MFD",
      name: "Dual Run Motor Capacitor 35+5 MFD 450VAC",
      itemType: "Spare Part",
      category: "Capacitors",
      brand: "Generic Parts",
      capacity: "35+5 uF 450V Round CBB65",
      unitOfMeasure: "PCS",
      unitCost: 280,
      listPrice: 480,
      quantity: 35,
      reorderLevel: 10,
      supplier: "Apex HVAC Components & Metal Fabrication",
      compatibleModels: ["CAR-1.0HP-CRY", "CAR-1.5HP-INV", "KOL-1.0HP-WINV"],
      priceHistory: [{ cost: 280, note: "Initial stock intake" }],
    },
    {
      branchId: "LOCAL-WAREHOUSE",
      sku: "MOT-FAN-OUT-45W",
      name: "Condenser Outdoor Fan Motor 45W",
      itemType: "Spare Part",
      category: "Fan Motors",
      brand: "Panasonic",
      capacity: "45W 220V 850 RPM",
      unitOfMeasure: "UNIT",
      unitCost: 2450,
      listPrice: 3600,
      quantity: 4,
      reorderLevel: 2,
      supplier: "Panasonic Manufacturing Phils.",
      compatibleModels: ["PANA-1.5HP-XPU", "CAR-1.5HP-INV"],
      priceHistory: [{ cost: 2450, note: "Initial stock intake" }],
    },
    {
      branchId: "LOCAL-WAREHOUSE",
      sku: "PCB-MAIN-INV-CAR",
      name: "Carrier Crystal Indoor Main Control PCB",
      itemType: "Spare Part",
      category: "PCBs & Inverters",
      brand: "Carrier",
      capacity: "Model Crystal Series Rev 3",
      unitOfMeasure: "PCS",
      unitCost: 3800,
      listPrice: 5500,
      quantity: 3,
      reorderLevel: 2,
      supplier: "Concepcion-Carrier Air Conditioning Co.",
      compatibleModels: ["CAR-1.0HP-CRY", "CAR-1.5HP-INV"],
      priceHistory: [{ cost: 3800, note: "Initial stock intake" }],
    },

    // --- 3. CONSUMABLES ---
    {
      branchId: "LOCAL-WAREHOUSE",
      sku: "FRN-R410A-11.3",
      name: "DuPont Suva Freon R410A Refrigerant Tank",
      itemType: "Consumable",
      category: "Refrigerants",
      brand: "Generic Parts",
      capacity: "11.3 kg / 25 lbs Cylinder",
      unitOfMeasure: "CYL",
      unitCost: 3850,
      listPrice: 5200,
      quantity: 20,
      reorderLevel: 5,
      supplier: "Chemours Specialty Chemicals",
      compatibleModels: ["CAR-1.0HP-CRY", "CAR-1.5HP-INV", "KOL-1.0HP-WINV", "GREE-3.0TR-FLR"],
      priceHistory: [{ cost: 3850, note: "Initial stock intake" }],
    },
    {
      branchId: "LOCAL-WAREHOUSE",
      sku: "FRN-R32-9.5KG",
      name: "Daikin Genuine Eco-Refrigerant R32 Cylinder",
      itemType: "Consumable",
      category: "Refrigerants",
      brand: "Daikin",
      capacity: "9.5 kg Cylinder",
      unitOfMeasure: "CYL",
      unitCost: 4600,
      listPrice: 6200,
      quantity: 15,
      reorderLevel: 4,
      supplier: "Daikin Airconditioning Phils Inc.",
      compatibleModels: ["DAIK-1.0HP-INV", "PANA-1.5HP-XPU"],
      priceHistory: [{ cost: 4600, note: "Initial stock intake" }],
    },
    {
      branchId: "LOCAL-WAREHOUSE",
      sku: "COP-1/4-3/8-15M",
      name: "Insulated Pair Copper Pipe Coil 1/4\" x 3/8\"",
      itemType: "Consumable",
      category: "Copper Tubing",
      brand: "Kembla",
      capacity: "15 Meters Roll with Armaflex",
      unitOfMeasure: "ROLL",
      unitCost: 2250,
      listPrice: 3100,
      quantity: 25,
      reorderLevel: 6,
      supplier: "Kembla Copper Tube Phils.",
      compatibleModels: ["CAR-1.0HP-CRY", "DAIK-1.0HP-INV"],
      priceHistory: [{ cost: 2250, note: "Initial stock intake" }],
    },
    {
      branchId: "LOCAL-WAREHOUSE",
      sku: "COP-1/4-1/2-15M",
      name: "Insulated Pair Copper Pipe Coil 1/4\" x 1/2\"",
      itemType: "Consumable",
      category: "Copper Tubing",
      brand: "Kembla",
      capacity: "15 Meters Roll with Armaflex",
      unitOfMeasure: "ROLL",
      unitCost: 2950,
      listPrice: 3950,
      quantity: 18,
      reorderLevel: 5,
      supplier: "Kembla Copper Tube Phils.",
      compatibleModels: ["CAR-1.5HP-INV", "PANA-1.5HP-XPU"],
      priceHistory: [{ cost: 2950, note: "Initial stock intake" }],
    },
    {
      branchId: "LOCAL-WAREHOUSE",
      sku: "MAT-DRAIN-HOSE",
      name: "Heavy Duty Flexible AC Drain Hose 5/8\"",
      itemType: "Consumable",
      category: "Installation Materials",
      brand: "Generic Parts",
      capacity: "50 Meters Roll",
      unitOfMeasure: "ROLL",
      unitCost: 850,
      listPrice: 1350,
      quantity: 22,
      reorderLevel: 5,
      supplier: "Apex HVAC Components & Metal Fabrication",
      compatibleModels: ["CAR-1.0HP-CRY", "CAR-1.5HP-INV", "DAIK-1.0HP-INV", "PANA-1.5HP-XPU"],
      priceHistory: [{ cost: 850, note: "Initial stock intake" }],
    },
    {
      branchId: "LOCAL-WAREHOUSE",
      sku: "MAT-WALL-BRKT-L",
      name: "Heavy-Duty Powder Coated Outdoor AC Bracket",
      itemType: "Consumable",
      category: "Installation Materials",
      brand: "Generic Parts",
      capacity: "For 1.0 HP – 2.5 HP Condensers",
      unitOfMeasure: "PAIR",
      unitCost: 650,
      listPrice: 1050,
      quantity: 30,
      reorderLevel: 8,
      supplier: "Apex HVAC Components & Metal Fabrication",
      compatibleModels: ["CAR-1.0HP-CRY", "CAR-1.5HP-INV", "DAIK-1.0HP-INV", "PANA-1.5HP-XPU"],
      priceHistory: [{ cost: 650, note: "Initial stock intake" }],
    },

    // --- 4. TOOLS / EQUIPMENT ---
    {
      branchId: "LOCAL-WAREHOUSE",
      sku: "TOOL-VAC-2STAGE",
      name: "Robinair 2-Stage HVAC Vacuum Pump 5 CFM",
      itemType: "Tool / Equipment",
      category: "Vacuum Pumps",
      brand: "Generic Parts",
      capacity: "5 CFM Dual Stage Deep Vacuum",
      unitOfMeasure: "UNIT",
      unitCost: 11500,
      listPrice: 15800,
      quantity: 4,
      reorderLevel: 1,
      supplier: "Apex HVAC Components & Metal Fabrication",
      priceHistory: [{ cost: 11500, note: "Initial equipment intake" }],
    },
    {
      branchId: "LOCAL-WAREHOUSE",
      sku: "TOOL-MANIFOLD-DIG",
      name: "Digital 4-Way Manifold Gauge Set (R32 / R410A)",
      itemType: "Tool / Equipment",
      category: "Manifold Gauges",
      brand: "Generic Parts",
      capacity: "Dual Pressure Transducers & Temperature Clamps",
      unitOfMeasure: "SET",
      unitCost: 8900,
      listPrice: 12500,
      quantity: 6,
      reorderLevel: 2,
      supplier: "Apex HVAC Components & Metal Fabrication",
      priceHistory: [{ cost: 8900, note: "Initial equipment intake" }],
    },

    // --- 5. INITIAL MOBILE STOCK ON SERVICE VAN ALPHA (VAN-01) ---
    {
      branchId: "VAN-01",
      sku: "FRN-R410A-11.3",
      name: "DuPont Suva Freon R410A Refrigerant Tank",
      itemType: "Consumable",
      category: "Refrigerants",
      brand: "Generic Parts",
      capacity: "11.3 kg / 25 lbs Cylinder",
      unitOfMeasure: "CYL",
      unitCost: 3850,
      listPrice: 5200,
      quantity: 2,
      reorderLevel: 1,
      supplier: "Chemours Specialty Chemicals",
      compatibleModels: ["CAR-1.0HP-CRY", "CAR-1.5HP-INV", "KOL-1.0HP-WINV"],
      priceHistory: [{ cost: 3850, note: "Van allocation" }],
    },
    {
      branchId: "VAN-01",
      sku: "MAT-CAP-35-5MFD",
      name: "Dual Run Motor Capacitor 35+5 MFD 450VAC",
      itemType: "Spare Part",
      category: "Capacitors",
      brand: "Generic Parts",
      capacity: "35+5 uF 450V Round CBB65",
      unitOfMeasure: "PCS",
      unitCost: 280,
      listPrice: 480,
      quantity: 5,
      reorderLevel: 2,
      supplier: "Apex HVAC Components & Metal Fabrication",
      compatibleModels: ["CAR-1.0HP-CRY", "CAR-1.5HP-INV"],
      priceHistory: [{ cost: 280, note: "Van allocation" }],
    },
    {
      branchId: "VAN-01",
      sku: "TOOL-MANIFOLD-DIG",
      name: "Digital 4-Way Manifold Gauge Set (R32 / R410A)",
      itemType: "Tool / Equipment",
      category: "Manifold Gauges",
      brand: "Generic Parts",
      capacity: "Dual Pressure Transducers & Temperature Clamps",
      unitOfMeasure: "SET",
      unitCost: 8900,
      listPrice: 12500,
      quantity: 1,
      reorderLevel: 1,
      supplier: "Apex HVAC Components & Metal Fabrication",
      priceHistory: [{ cost: 8900, note: "Van equipment assignment" }],
    },
  ];

  const createdProducts = await Product.insertMany(products);
  console.log(`Seeded ${createdProducts.length} clean inventory items.`);

  // 7. Seed Movements for Opening Balances & Sample Dispatches
  const movements = [];
  const adminUser = users[0];

  for (let i = 0; i < createdProducts.length; i++) {
    const item = createdProducts[i];
    movements.push({
      productId: item._id,
      branchId: item.branchId,
      sku: item.sku,
      itemName: item.name,
      unitOfMeasure: item.unitOfMeasure,
      movementType: "OPENING",
      quantityDelta: item.quantity,
      beforeQuantity: 0,
      afterQuantity: item.quantity,
      referenceId: `STI26${String(i + 1).padStart(2, "0")}`,
      reason: "Initial clean database intake balance",
      performedBy: String(adminUser._id || "system"),
      performedByName: adminUser.fullName,
      createdAt: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000), // 15 days ago
    });
  }

  // Add realistic dispatch movements in the past 10 days for Fast-Moving analytics
  const carItem = createdProducts.find(
    (p) => p.sku === "CAR-1.0HP-CRY" && p.branchId === "LOCAL-WAREHOUSE",
  );
  if (carItem) {
    movements.push({
      productId: carItem._id,
      branchId: carItem.branchId,
      sku: carItem.sku,
      itemName: carItem.name,
      unitOfMeasure: carItem.unitOfMeasure,
      movementType: "STOCK_OUT",
      quantityDelta: -3,
      beforeQuantity: 15,
      afterQuantity: 12,
      referenceId: "STO2601",
      reason: "Client Installation / Site Project: Taguig BGC Condo Tower 2",
      workOrderId: "JOB-2026-101",
      performedBy: String(adminUser._id || "system"),
      performedByName: adminUser.fullName,
      createdAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000), // 5 days ago
    });
  }

  const freonItem = createdProducts.find(
    (p) => p.sku === "FRN-R410A-11.3" && p.branchId === "LOCAL-WAREHOUSE",
  );
  if (freonItem) {
    movements.push({
      productId: freonItem._id,
      branchId: freonItem.branchId,
      sku: freonItem.sku,
      itemName: freonItem.name,
      unitOfMeasure: freonItem.unitOfMeasure,
      movementType: "STOCK_OUT",
      quantityDelta: -5,
      beforeQuantity: 25,
      afterQuantity: 20,
      referenceId: "STO2602",
      reason: "Client Installation / Site Project: Pasay Hotel Maintenance",
      workOrderId: "JOB-2026-108",
      performedBy: String(adminUser._id || "system"),
      performedByName: adminUser.fullName,
      createdAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000), // 3 days ago
    });
  }

  // Seed sample van transfer
  const vanItem = createdProducts.find(
    (p) => p.branchId === "VAN-01" && p.sku === "CP-PIPE-1/4",
  );
  if (vanItem) {
    movements.push(
      {
        productId: vanItem._id,
        branchId: "LOCAL-WAREHOUSE",
        sku: vanItem.sku,
        itemName: vanItem.name,
        unitOfMeasure: vanItem.unitOfMeasure,
        movementType: "TRANSFER_OUT",
        quantityDelta: -4,
        beforeQuantity: 24,
        afterQuantity: 20,
        referenceId: "TRA2601",
        reason: "Van Loadout: Initial alpha van staging",
        performedBy: String(adminUser._id || "system"),
        performedByName: adminUser.fullName,
        createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
      },
      {
        productId: vanItem._id,
        branchId: "VAN-01",
        sku: vanItem.sku,
        itemName: vanItem.name,
        unitOfMeasure: vanItem.unitOfMeasure,
        movementType: "TRANSFER_IN",
        quantityDelta: 4,
        beforeQuantity: 0,
        afterQuantity: 4,
        referenceId: "TRA2601",
        reason: "Van Loadout: Initial alpha van staging",
        performedBy: String(adminUser._id || "system"),
        performedByName: adminUser.fullName,
        createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
      },
    );
  }

  await Movement.insertMany(movements);
  console.log(`Seeded ${movements.length} initial ledger movements with STI/STO/TRA tickets.`);

  // 8. Seed sample Material Request demonstrating Reserved Stock
  if (freonItem) {
    await PartRequest.create({
      branchId: "LOCAL-WAREHOUSE",
      productId: freonItem._id,
      sku: freonItem.sku,
      itemName: freonItem.name,
      unitOfMeasure: freonItem.unitOfMeasure,
      workOrderId: "AC-SRV-2026-44",
      quantityNeeded: 2,
      notes: "Reserved for scheduled Makati Office preventative servicing tomorrow",
      status: "APPROVED",
      requestedBy: "technician@ashcol.com",
      requestedByName: "Field Technician Lead",
      reviewedByName: "Admin Master (Hatdog)",
      reviewedAt: new Date(),
    });
    console.log("Seeded approved material request (2 Freon tanks reserved).");
  }

  console.log("Database reset and new demo data seeding completed successfully!");
  await mongoose.disconnect();
}

resetAndSeed().catch((err) => {
  console.error("Reset failed:", err);
  process.exit(1);
});
