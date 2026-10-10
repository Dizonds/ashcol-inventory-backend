import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import mongoose from 'mongoose';

const app = express();
const PORT = process.env.PORT || 3001;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/ashcol_inventory';

app.use(cors());
app.use(express.json());

const productSchema = new mongoose.Schema(
  {
    sku: { type: String, required: true },
    name: { type: String, required: true },
    category: { type: String, default: 'Split Type' },
    itemType: { type: String, default: 'AC Unit' },
    brand: { type: String, default: 'Carrier' },
    capacity: { type: String, default: '1.0 HP' },
    unitOfMeasure: { type: String, default: 'UNIT' },
    unitCost: { type: Number, default: 0 },
    listPrice: { type: Number, default: 0 },
    quantity: { type: Number, default: 0 },
    reorderLevel: { type: Number, default: 3 },
  },
  { timestamps: true }
);

const movementSchema = new mongoose.Schema(
  {
    sku: { type: String, required: true },
    itemName: { type: String, required: true },
    movementType: { type: String, default: 'STOCK_IN' },
    quantityDelta: { type: Number, required: true },
    reason: { type: String, default: 'Warehouse Delivery' },
    date: { type: String, default: () => new Date().toISOString().split('T')[0] },
  },
  { timestamps: true }
);

const brandSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },
  },
  { timestamps: true }
);

const Product = mongoose.model('Product', productSchema, 'products');
const Movement = mongoose.model('Movement', movementSchema, 'stock_movements');
const Brand = mongoose.model('Brand', brandSchema, 'brands');

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

app.get('/api/products', async (req, res) => {
  try {
    const items = await Product.find().sort({ createdAt: -1 });
    res.json(
      items.map((doc) => ({
        id: doc._id.toString(),
        sku: doc.sku,
        name: doc.name,
        category: doc.category,
        itemType: doc.itemType,
        brand: doc.brand,
        capacity: doc.capacity,
        unitOfMeasure: doc.unitOfMeasure,
        unitCost: doc.unitCost,
        listPrice: doc.listPrice,
        quantity: doc.quantity,
        reorderLevel: doc.reorderLevel,
      }))
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/products', async (req, res) => {
  try {
    const { sku, name, category, itemType, brand, capacity, unitOfMeasure, unitCost, listPrice, quantity, reorderLevel } = req.body;
    const newItem = new Product({
      sku,
      name,
      category: category || 'Split Type',
      itemType: itemType || 'AC Unit',
      brand: brand || 'Carrier',
      capacity: capacity || '1.0 HP',
      unitOfMeasure: unitOfMeasure || 'UNIT',
      unitCost: Number(unitCost) || 0,
      listPrice: Number(listPrice) || 0,
      quantity: Number(quantity) || 0,
      reorderLevel: Number(reorderLevel) || 3,
    });
    await newItem.save();

    if (Number(quantity) > 0) {
      await Movement.create({
        sku: newItem.sku,
        itemName: newItem.name,
        movementType: 'STOCK_IN',
        quantityDelta: Number(quantity),
        reason: 'Initial Opening Stock Entry',
      });
    }

    res.status(201).json({
      id: newItem._id.toString(),
      sku: newItem.sku,
      name: newItem.name,
      category: newItem.category,
      itemType: newItem.itemType,
      brand: newItem.brand,
      capacity: newItem.capacity,
      unitOfMeasure: newItem.unitOfMeasure,
      unitCost: newItem.unitCost,
      listPrice: newItem.listPrice,
      quantity: newItem.quantity,
      reorderLevel: newItem.reorderLevel,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/products/:id/stock', async (req, res) => {
  try {
    const { id } = req.params;
    const { delta, reason } = req.body;
    const item = await Product.findById(id);
    if (!item) return res.status(404).json({ error: 'Item not found' });

    const change = Number(delta);
    item.quantity = Math.max(0, item.quantity + change);
    await item.save();

    await Movement.create({
      sku: item.sku,
      itemName: item.name,
      movementType: change >= 0 ? 'STOCK_IN' : 'STOCK_OUT',
      quantityDelta: change,
      reason: reason || (change >= 0 ? 'Supplier Delivery / Restock' : 'Dispatched for Installation'),
    });

    res.json({ id: item._id.toString(), quantity: item.quantity });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/products/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updated = await Product.findByIdAndUpdate(id, req.body, { new: true });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/products/:id', async (req, res) => {
  try {
    await Product.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: 'Item deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/movements', async (req, res) => {
  try {
    const logs = await Movement.find().sort({ createdAt: -1 }).limit(100);
    res.json(
      logs.map((m) => ({
        id: m._id.toString(),
        sku: m.sku,
        itemName: m.itemName,
        movementType: m.movementType,
        quantityDelta: m.quantityDelta,
        reason: m.reason,
        date: m.date,
      }))
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/brands', async (req, res) => {
  try {
    const brands = await Brand.find().sort({ name: 1 });
    res.json(
      brands.map((b) => ({
        id: b._id.toString(),
        name: b.name,
      }))
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/brands', async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Brand name is required' });
    }

    const trimmed = name.trim();
    const existing = await Brand.findOne({ name: { $regex: new RegExp(`^${trimmed}$`, 'i') } });
    if (existing) {
      return res.json({ id: existing._id.toString(), name: existing.name });
    }

    const created = await Brand.create({ name: trimmed });
    res.status(201).json({ id: created._id.toString(), name: created.name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/brands/:id', async (req, res) => {
  try {
    await Brand.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: 'Brand deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

mongoose
  .connect(MONGO_URI)
  .then(async () => {
    try {
      const count = await Brand.countDocuments();
      if (count === 0) {
        const defaultBrands = [
          'Carrier',
          'Daikin',
          'Panasonic',
          'LG',
          'Kolin',
          'Samsung',
          'Mitsubishi',
          'Midea',
          'Gree',
          'TCL',
          'Hitachi',
          'Toshiba',
          'Generic Parts',
        ];
        await Brand.insertMany(defaultBrands.map((name) => ({ name })));
      }
    } catch (e) {
      console.log(e.message);
    }

    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('DB Connection Error:', err.message);
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  });
