import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { initializeDatabase } from "../src/setup.js";
import { reserveRequestReference } from "../src/request-numbers.js";
import { reserveMovementTicket } from "../src/movement-tickets.js";
import { planDemoActivity } from "./demo-activity.js";
import mongoose from "mongoose";
import { hashPassword } from "../src/auth.js";
import {
  Product,
  Movement,
  ServiceVan,
  Brand,
  Supplier,
  User,
  Session,
  PartRequest,
  RequestReference,
  Counter,
  MovementTicket,
  JobOrder,
} from "../src/models.js";

async function resetAndSeed() {
  await mongoose.connect(
    process.env.MONGO_URI || "mongodb://127.0.0.1:27017/ashcol_inventory",
  );
  console.log(`Connected to ${mongoose.connection.host}:${mongoose.connection.port}/${mongoose.connection.name}.`);
  const models = [Product, Movement, ServiceVan, Brand, Supplier, User, Session, PartRequest, RequestReference, Counter, MovementTicket, JobOrder];
  const backup = {};
  for (const model of models) backup[model.collection.name] = await model.collection.find({}).toArray();
  if (Object.values(backup).some((documents) => documents.length)) {
    const backupDirectory = path.join(process.env.LOCALAPPDATA || os.tmpdir(), "AshcolInventory", "backups");
    await fs.mkdir(backupDirectory, { recursive: true });
    const backupFile = path.join(backupDirectory, `${mongoose.connection.name}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    await fs.writeFile(backupFile, mongoose.mongo.BSON.EJSON.stringify(backup, { relaxed: false }), { flag: "wx" });
    console.log(`Backup saved: ${backupFile}`);
  }

  // 1. Clear inventory collections
  await Promise.all(models.map((model) => model.deleteMany({})));
  await initializeDatabase();
  // The initializer supplies default brands for an empty database.
  await Brand.deleteMany({});
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

  // 3. Seed service vans. The fixed Taguig warehouse is represented by
  // the LOCAL-WAREHOUSE scope and is not a ServiceVan document.
  const serviceVans = [
    {
      _id: "VAN-01",
      name: "Field Service Van Alpha",
      plateNumber: "NBD-1234",
      vehicleType: "Cargo Van",
      driverName: "Alex Rivera (Lead Tech)",
      status: "AVAILABLE",
    },
    {
      _id: "VAN-02",
      name: "Field Service Van Bravo",
      plateNumber: "ABC-5678",
      vehicleType: "Pickup",
      driverName: "Danilo Santos (Senior Tech)",
      status: "ON_FIELD",
    },
  ];
  await ServiceVan.insertMany(serviceVans);
  console.log(`Seeded ${serviceVans.length} service vans.`);

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
      email: "admin@ashcol.com",
      firstName: "Admin",
      lastName: "admin",
      fullName: "Admin admin",
      role: "ADMIN",
      branchId: "LOCAL-WAREHOUSE",
      passwordHash: await hashPassword("admin@ashcol.com"),
    },
    {
      email: "manager@ashcol.com",
      firstName: "Miguel",
      lastName: "Reyes",
      fullName: "Miguel Reyes",
      role: "MANAGER",
      branchId: "LOCAL-WAREHOUSE",
      passwordHash,
    },
    {
      email: "technician@ashcol.com",
      firstName: "Adrian",
      lastName: "Santos",
      fullName: "Adrian Santos",
      role: "EMPLOYEE",
      branchId: "LOCAL-WAREHOUSE",
      passwordHash,
    },
    ...[
      ["technician2@ashcol.com", "Carlo", "Navarro"],
      ["technician3@ashcol.com", "Joshua", "Cruz"],
      ["technician4@ashcol.com", "Rafael", "Garcia"],
    ].map(([email, firstName, lastName]) => ({
      email, firstName, lastName, fullName: `${firstName} ${lastName}`,
      role: "EMPLOYEE", branchId: "LOCAL-WAREHOUSE", passwordHash,
    })),
  ];
  const createdUsers = await User.insertMany(users);
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
  const [adminUser, managerUser, technician] = createdUsers;
  await ServiceVan.updateOne({ _id: "VAN-01" }, {
    $set: { driverId: String(technician._id), driverName: technician.fullName },
  });
  console.log(`Seeded ${createdProducts.length} inventory items.`);

  // Use past Manila calendar dates; no synthetic activity is placed in the future.
  const todayKey = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const dayAt = (daysAgo, hour = 10) => new Date(new Date(`${todayKey}T00:00:00+08:00`).getTime() - daysAgo * 86400000 + hour * 3600000);
  const movements = [];
  async function recordMovement(item, delta, movementType, daysAgo, reason, extra = {}) {
    const beforeQuantity = item.quantity;
    const afterQuantity = beforeQuantity + delta;
    if (afterQuantity < 0) throw new Error(`Insufficient seed stock for ${item.sku}`);
    const ticketType = delta >= 0 ? "STOCK_IN" : "STOCK_OUT";
    const ticket = extra.referenceId ? null : await reserveMovementTicket(ticketType, String(adminUser._id));
    const createdAt = extra.createdAt || dayAt(daysAgo);
    movements.push({
      productId: item._id, branchId: item.branchId, sku: item.sku,
      itemName: item.name, itemType: item.itemType, category: item.category,
      brand: item.brand, unitOfMeasure: item.unitOfMeasure,
      movementType, quantityDelta: delta, beforeQuantity, afterQuantity,
      referenceId: ticket?._id, reason, performedBy: String(adminUser._id),
      performedByName: adminUser.fullName, createdAt, ...extra,
    });
    if (ticket) { ticket.usedAt = createdAt; await ticket.save(); }
    item.quantity = afterQuantity;
  }
  for (const item of createdProducts) {
    const quantity = item.quantity;
    item.quantity = 0;
    await recordMovement(item, quantity, "OPENING", 35, "Opening inventory balance");
  }
  const warehouseItems = createdProducts.filter((item) => item.branchId === "LOCAL-WAREHOUSE");
  for (const entry of planDemoActivity(warehouseItems, dayAt)) {
    await recordMovement(entry.item, entry.delta, entry.movementType, 1, entry.reason,
      { createdAt: entry.createdAt });
  }

  const warehouseCopper = warehouseItems.find((item) => item.sku === "CP-PIPE-1/4");
  const vanCopper = createdProducts.find((item) => item.branchId === "VAN-01" && item.sku === "CP-PIPE-1/4");
  if (warehouseCopper && vanCopper && warehouseCopper.quantity >= 4) {
    await recordMovement(warehouseCopper, -4, "TRANSFER_OUT", 1, "Initial Alpha van loadout", { referenceId: "TRA0001" });
    await recordMovement(vanCopper, 4, "TRANSFER_IN", 1, "Initial Alpha van loadout", { referenceId: "TRA0001" });
  }

  const requestItem = warehouseItems.find((item) => item.sku === "FRN-R410A-11.3");
  for (const [index, status] of ["PENDING", "APPROVED", "DENIED", "FULFILLED"].entries()) {
    const reference = await reserveRequestReference(String(technician._id));
    const requestedAt = dayAt(4 - index, 8);
    const history = [{ status: "PENDING", performedByName: technician.fullName, at: requestedAt }];
    const review = status === "PENDING" ? {} : {
      reviewedByName: managerUser.fullName, reviewedAt: dayAt(4 - index, 9),
      ...(status === "DENIED" ? { decisionReason: "Duplicate material request" } : {}),
    };
    if (status !== "PENDING") history.push({
      status: status === "DENIED" ? "DENIED" : "APPROVED", performedByName: managerUser.fullName,
      at: review.reviewedAt, ...(review.decisionReason ? { reason: review.decisionReason } : {}),
    });
    if (status === "FULFILLED") history.push({ status, performedByName: adminUser.fullName, at: dayAt(1, 10) });
    await PartRequest.create({
      _id: reference._id, requestNumber: reference.requestNumber, workOrderId: reference.requestNumber,
      branchId: requestItem.branchId, productId: requestItem._id, sku: requestItem.sku,
      destinationVanId: "VAN-01", destinationVanName: serviceVans[0].name,
      itemName: requestItem.name, itemType: requestItem.itemType, category: requestItem.category,
      brand: requestItem.brand, unitOfMeasure: requestItem.unitOfMeasure,
      quantityNeeded: 2, notes: `Sample ${status.toLowerCase()} service materials request`, status,
      requestedBy: String(technician._id), requestedByName: technician.fullName,
      createdAt: requestedAt, history, ...review,
      ...(status === "FULFILLED" ? { fulfilledByName: adminUser.fullName, fulfilledAt: dayAt(1, 10) } : {}),
    });
    if (status === "FULFILLED") {
      const receipt = { referenceId: String(reference._id), requestNumber: reference.requestNumber, workOrderId: reference.requestNumber };
      await recordMovement(requestItem, -2, "REQUEST_ISSUE", 1, "Materials released for approved service request", receipt);
      let target = createdProducts.find((item) => item.branchId === "VAN-01" && item.sku === requestItem.sku);
      if (!target) {
        target = await Product.create({ ...requestItem.toObject(), _id: new mongoose.Types.ObjectId(), branchId: "VAN-01", quantity: 0 });
        createdProducts.push(target);
      }
      await recordMovement(target, 2, "TRANSFER_IN", 1, "Approved material request received in assigned vehicle", receipt);
    }
  }
  for (const item of createdProducts) await item.save();
  await Movement.insertMany(movements);
  await Counter.updateOne({ _id: "JOB" }, { $set: { value: 1 } }, { upsert: true });
  await JobOrder.create({
    jobNumber: "JOB0001", title: "Office AC installation", customerName: "Demo customer",
    location: "Taguig City", description: "Install and test the office air conditioner.",
    assignedTechnicianId: technician._id, technicianName: technician.fullName,
    vanId: "VAN-01", vanName: serviceVans[0].name, createdByName: managerUser.fullName,
    isCurrent: true, assignedAt: new Date(), assignedByName: managerUser.fullName,
  });
  console.log(`Seeded ${movements.length} balanced ledger records and four numbered material requests.`);

  console.log("Database reset and new demo data seeding completed successfully!");
  await mongoose.disconnect();
}

resetAndSeed().catch(async (err) => {
  console.error("Reset failed:", err);
  await mongoose.disconnect();
  process.exitCode = 1;
});
