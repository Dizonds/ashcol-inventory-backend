import "dotenv/config";
import mongoose from "mongoose";

const uri = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/ashcol_inventory?replicaSet=rs0";
const apply = process.argv.includes("--apply");
const requestNumberPattern = /^REQ\d{4,}$/;

async function main() {
  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  const movements = db.collection("stock_movements");
  const requests = db.collection("partrequests");
  const jobs = await db.collection("joborders").find({}, { projection: { jobNumber: 1 } }).toArray();
  const jobsByNumber = new Map(jobs.map((job) => [job.jobNumber, job._id]));
  const movementRows = await movements.find({
    $or: [
      { jobOrderId: { $exists: true } },
      { workOrderId: { $exists: true } },
    ],
  }).toArray();
  const requestRows = await requests.find({ workOrderId: { $exists: true } }).toArray();
  const movementOps = [];
  const requestOps = [];
  const conflicts = [];

  for (const row of movementRows) {
    const set = {};
    const unset = {};
    let linkedJobId = row.jobId || row.jobOrderId;
    if (row.jobOrderId) {
      if (row.jobId && String(row.jobId) !== String(row.jobOrderId)) conflicts.push(`stock_movements ${row._id}: jobId disagrees with jobOrderId`);
      else if (!row.jobId) set.jobId = row.jobOrderId;
      unset.jobOrderId = "";
    }
    if (row.workOrderId !== undefined) {
      const oldValue = row.workOrderId;
      const matchingJobId = jobsByNumber.get(oldValue);
      if (!linkedJobId && matchingJobId) {
        linkedJobId = matchingJobId;
        set.jobId = matchingJobId;
      }
      const target = oldValue === row.requestNumber || (!row.requestNumber && requestNumberPattern.test(oldValue))
        ? null
        : linkedJobId ? "jobNumber" : "referenceNumber";
      if (target) {
        if (row[target] !== undefined && row[target] !== oldValue) conflicts.push(`stock_movements ${row._id}: ${target} disagrees with workOrderId`);
        else if (row[target] === undefined) set[target] = oldValue;
      }
      unset.workOrderId = "";
    }
    if (Object.keys(set).length || Object.keys(unset).length) {
      movementOps.push({ updateOne: { filter: { _id: row._id }, update: {
        ...(Object.keys(set).length ? { $set: set } : {}),
        $unset: unset,
      } } });
    }
  }

  for (const row of requestRows) {
    const set = {};
    const unset = { workOrderId: "" };
    const oldValue = row.workOrderId;
    const isRequestNumber = oldValue === row.requestNumber || (!row.requestNumber && requestNumberPattern.test(oldValue));
    if (!isRequestNumber) {
      if (row.jobNumber !== undefined && row.jobNumber !== oldValue) conflicts.push(`partrequests ${row._id}: jobNumber disagrees with workOrderId`);
      else if (row.jobNumber === undefined) set.jobNumber = oldValue;
      const matchingJobId = jobsByNumber.get(oldValue);
      if (matchingJobId) {
        if (row.jobId && String(row.jobId) !== String(matchingJobId)) conflicts.push(`partrequests ${row._id}: jobId disagrees with the matching jobNumber`);
        else if (!row.jobId) set.jobId = matchingJobId;
      }
    }
    requestOps.push({ updateOne: { filter: { _id: row._id }, update: {
      ...(Object.keys(set).length ? { $set: set } : {}),
      $unset: unset,
    } } });
  }

  console.log(`Found ${movementRows.length} movement record(s) and ${requestRows.length} request record(s) using legacy names.`);
  if (conflicts.length) {
    console.error("Migration stopped because target fields already contain different values:");
    for (const conflict of conflicts) console.error(`- ${conflict}`);
    process.exitCode = 1;
    return;
  }
  if (!apply) {
    console.log("Dry run only. Review the counts, back up the database, then rerun with --apply to rename fields.");
    return;
  }
  if (movementOps.length) await movements.bulkWrite(movementOps, { ordered: true });
  if (requestOps.length) await requests.bulkWrite(requestOps, { ordered: true });
  const remaining = await Promise.all([
    movements.countDocuments({ $or: [{ jobOrderId: { $exists: true } }, { workOrderId: { $exists: true } }] }),
    requests.countDocuments({ workOrderId: { $exists: true } }),
  ]);
  if (remaining.some(Boolean)) throw new Error(`Verification found ${remaining[0]} movement and ${remaining[1]} request legacy fields remaining.`);
  console.log(`Migration complete: updated ${movementOps.length} movement record(s) and ${requestOps.length} request record(s).`);
}

main()
  .catch((error) => { console.error("Job-link migration failed:", error.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect());
