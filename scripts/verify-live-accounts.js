// Read-only account fingerprint around a local API restart. No credentials are logged.
import 'dotenv/config';
import mongoose from 'mongoose';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const file = new URL('../../.local-backups/qa-fix-account-fingerprint.json', import.meta.url);
try {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/ashcol_inventory?replicaSet=rs0');
  const accounts = await mongoose.connection.collection('users').find({}).sort({ _id: 1 }).toArray();
  const current = { count: accounts.length, fingerprint: createHash('sha256').update(JSON.stringify(accounts)).digest('hex') };
  if (process.argv[2] === 'before') {
    await fs.writeFile(file, JSON.stringify(current));
    console.log(`Recorded read-only fingerprint for ${current.count} account records.`);
  } else {
    assert.deepEqual(current, JSON.parse(await fs.readFile(file, 'utf8')));
    console.log(`All ${current.count} account records, including credentials, are unchanged.`);
  }
} finally { await mongoose.disconnect(); }
