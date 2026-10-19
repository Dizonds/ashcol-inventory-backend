import { Router } from "express";
import mongoose from "mongoose";
import { JobOrder, Counter, User, Movement } from "../database/models.js";
import { manage } from "../security/auth.js";
import { text, fail, json, transaction, lockServiceVan, branchScope, inventoryRecordJson } from "../utils/helpers.js";

const router = Router();
const validId = (id) => { if (!mongoose.isValidObjectId(id)) fail("Invalid job order ID."); };
const visibleTo = (job, user) => user.role !== "EMPLOYEE" || String(job.assignedTechnicianId) === String(user._id);

router.get("/job-orders", (req, res, next) => {
  const filter = req.user.role === "EMPLOYEE" ? { assignedTechnicianId: req.user._id } : {};
  if (req.query.archived !== undefined && !["true", "false"].includes(req.query.archived))
    fail("Choose a valid archive filter.");
  filter.archived = req.query.archived === "true" ? true : { $ne: true };
  if (req.query.status) {
    if (!["OPEN", "COMPLETED", "CANCELLED"].includes(req.query.status)) fail("Choose a valid job status.");
    filter.status = req.query.status;
  }
  if (req.query.current !== undefined) {
    if (!["true", "false"].includes(req.query.current)) fail("Choose a valid current-job filter.");
    filter.isCurrent = req.query.current === "true";
  }
  Promise.resolve(req.query.vanId ? branchScope(req, req.query.vanId) : null)
    .then((vanId) => {
      if (vanId) filter.vanId = vanId;
      return JobOrder.find(filter).sort({ createdAt: -1, _id: -1 });
    })
    .then((jobs) => res.json(jobs.map(json))).catch(next);
});

router.post("/job-orders", manage, (req, res, next) => {
  const fields = {
    title: text(req.body.title, "Job title"), customerName: text(req.body.customerName, "Customer"),
    location: text(req.body.location, "Location"), description: text(req.body.description || "", "Description", false),
    vanId: text(req.body.vanId, "Service vehicle"),
  };
  if (fields.vanId === "LOCAL-WAREHOUSE") fail("Assign a service vehicle to the job.");
  validId(req.body.assignedTechnicianId);
  transaction(async (session) => {
    const van = await lockServiceVan(fields.vanId, session);
    const technician = await User.findOneAndUpdate(
      { _id: req.body.assignedTechnicianId, role: "EMPLOYEE" }, { $inc: { __v: 1 } }, { new: true, session },
    );
    if (!technician) fail("Choose an active technician.");
    if (van.driverId ? van.driverId !== String(technician._id) :
      ![technician.fullName, `${technician.fullName} (${technician.role})`].includes(van.driverName))
      fail("The technician must be assigned to the selected service vehicle.", 409);
    const counter = await Counter.findOneAndUpdate({ _id: "JOB" }, { $inc: { value: 1 } }, { upsert: true, new: true, session });
    const [job] = await JobOrder.create([{
      ...fields, jobNumber: `JOB${String(counter.value).padStart(4, "0")}`,
      assignedTechnicianId: technician._id, technicianName: technician.fullName, vanName: van.name,
      createdByName: req.user.fullName,
    }], { session });
    return json(job);
  }).then((job) => res.status(201).json(job)).catch(next);
});

router.get("/job-orders/:id", (req, res, next) => {
  validId(req.params.id);
  JobOrder.findById(req.params.id).then(async (job) => {
    if (!job || !visibleTo(job, req.user)) fail("Job order not found.", 404);
    const movements = await Movement.find({ jobId: job._id }).sort({ createdAt: -1, _id: -1 });
    res.json({ ...json(job), movements: movements.map(inventoryRecordJson) });
  }).catch(next);
});

router.delete("/job-orders/:id", manage, (req, res, next) => {
  validId(req.params.id);
  transaction(async (session) => {
    const job = await JobOrder.findOneAndUpdate({
      _id: req.params.id, archived: { $ne: true },
      status: { $in: ["COMPLETED", "CANCELLED"] }, isCurrent: { $ne: true },
    }, { $set: { archived: true }, $inc: { __v: 1 } }, { new: true, session });
    if (!job) fail("Only completed or cancelled jobs can be archived. The job may already be archived.", 409);
    return json(job);
  }).then((job) => res.json(job)).catch(next);
});

router.post("/job-orders/:id/restore", manage, (req, res, next) => {
  validId(req.params.id);
  transaction(async (session) => {
    const job = await JobOrder.findOneAndUpdate({ _id: req.params.id, archived: true },
      { $set: { archived: false }, $inc: { __v: 1 } }, { new: true, session });
    if (!job) fail("Archived job order not found.", 404);
    return json(job);
  }).then((job) => res.json(job)).catch(next);
});

router.patch("/job-orders/:id", manage, (req, res, next) => {
  validId(req.params.id);
  validId(req.body.assignedTechnicianId);
  const fields = {
    title: text(req.body.title, "Job title"), customerName: text(req.body.customerName, "Customer"),
    location: text(req.body.location, "Location"), description: text(req.body.description || "", "Description", false),
    vanId: text(req.body.vanId, "Service vehicle"),
  };
  if (fields.vanId === "LOCAL-WAREHOUSE") fail("Assign a service vehicle to the job.");
  transaction(async (session) => {
    await Counter.findOneAndUpdate({ _id: "job-dispatch" }, { $inc: { value: 1 } }, { upsert: true, new: true, session });
    const job = await JobOrder.findOne({ _id: req.params.id, status: "OPEN", archived: { $ne: true } }).session(session);
    if (!job) fail("Only open job orders can be edited.", 409);
    const van = await lockServiceVan(fields.vanId, session);
    const technician = await User.findOneAndUpdate(
      { _id: req.body.assignedTechnicianId, role: "EMPLOYEE" }, { $inc: { __v: 1 } }, { new: true, session },
    );
    if (!technician) fail("Choose an active technician.");
    if (van.driverId ? van.driverId !== String(technician._id) :
      ![technician.fullName, `${technician.fullName} (${technician.role})`].includes(van.driverName))
      fail("The technician must be assigned to the selected service vehicle.", 409);
    const changedAssignment = String(job.assignedTechnicianId) !== String(technician._id) || job.vanId !== van._id;
    if (job.isCurrent && changedAssignment) {
      await JobOrder.updateMany({ isCurrent: true, $or: [
        { _id: job._id }, { assignedTechnicianId: technician._id }, { vanId: van._id },
      ] }, { $set: { isCurrent: false }, $inc: { __v: 1 } }, { session });
    }
    const updated = await JobOrder.findByIdAndUpdate(job._id, { $set: {
      ...fields, assignedTechnicianId: technician._id, technicianName: technician.fullName, vanName: van.name,
      isCurrent: job.isCurrent,
      ...(job.isCurrent && changedAssignment ? { assignedAt: new Date(), assignedByName: req.user.fullName } : {}),
    }, $inc: { __v: 1 } }, { new: true, session });
    return json(updated);
  }).then((job) => res.json(job)).catch(next);
});

router.patch("/job-orders/:id/assignment", manage, (req, res, next) => {
  validId(req.params.id);
  transaction(async (session) => {
    await Counter.findOneAndUpdate({ _id: "job-dispatch" }, { $inc: { value: 1 } }, { upsert: true, new: true, session });
    const job = await JobOrder.findOne({ _id: req.params.id, status: "OPEN", archived: { $ne: true } }).session(session);
    if (!job) fail("Only an open job can be assigned.", 409);
    const van = await lockServiceVan(job.vanId, session);
    const technician = await User.findOneAndUpdate(
      { _id: job.assignedTechnicianId, role: "EMPLOYEE" }, { $inc: { __v: 1 } }, { new: true, session },
    );
    if (!technician) fail("The assigned technician is no longer available.", 409);
    if (van.driverId ? van.driverId !== String(technician._id) :
      ![technician.fullName, `${technician.fullName} (${technician.role})`].includes(van.driverName))
      fail("The technician is no longer assigned to this vehicle. Update the vehicle assignment first.", 409);
    await JobOrder.updateMany({
      isCurrent: true, $or: [{ assignedTechnicianId: technician._id }, { vanId: job.vanId }],
    }, { $set: { isCurrent: false }, $inc: { __v: 1 } }, { session });
    const assigned = await JobOrder.findByIdAndUpdate(job._id, {
      $set: { isCurrent: true, assignedAt: new Date(), assignedByName: req.user.fullName }, $inc: { __v: 1 },
    }, { new: true, session });
    return json(assigned);
  }).then((job) => res.json(job)).catch(next);
});

router.patch("/job-orders/:id/status", (req, res, next) => {
  validId(req.params.id);
  const status = text(req.body.status, "Status");
  if (!["COMPLETED", "CANCELLED"].includes(status)) fail("Choose Complete or Cancel.");
  if (req.user.role === "EMPLOYEE" && status !== "COMPLETED") fail("Only a manager can cancel a job.", 403);
  transaction(async (session) => {
    const filter = { _id: req.params.id, status: "OPEN", archived: { $ne: true } };
    if (req.user.role === "EMPLOYEE") {
      filter.assignedTechnicianId = req.user._id;
      filter.isCurrent = true;
    }
    const job = await JobOrder.findOneAndUpdate(filter, { $set: {
      status, isCurrent: false, closedAt: new Date(), closedByName: req.user.fullName,
    }, $inc: { __v: 1 } }, { new: true, session });
    if (!job) fail("This job is closed or is not assigned to you.", 409);
    return json(job);
  }).then((job) => res.json(job)).catch(next);
});

export default router;
