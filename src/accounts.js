import { User, Session, ServiceVan, Counter } from "./models.js";
import { timingSafeEqual } from "node:crypto";
import { hashPassword } from "./auth.js";
import { text, fail, json, transaction } from "./helpers.js";

export function accountNames(body) {
  const firstName = text(body.firstName, "First name");
  const lastName = text(body.lastName, "Last name");
  for (const name of [firstName, lastName])
    if (!/^[\p{L}][\p{L} .'-]{1,49}$/u.test(name)) fail("Names must contain 2-50 letters and valid name characters.");
  return { firstName, lastName, fullName: `${firstName} ${lastName}` };
}
export function validateNewPassword(password) {
  if (typeof password !== "string" || password.length < 10 || password.length > 200 || /\s/.test(password))
    fail("Use a password of 10-200 characters without spaces.");
  if (!/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/\d/.test(password))
    fail("Password must contain uppercase, lowercase, and a number.");
}
export async function updateAccount(req, id, administrative = false) {
  const names = accountNames(req.body);
  if (req.body.password !== undefined && typeof req.body.password !== "string") fail("Password must be text.");
  const password = req.body.password || "";
  if (password) validateNewPassword(password);
  return transaction(async (session) => {
    await Counter.findOneAndUpdate({ _id: "user-administration" }, { $inc: { value: 1 } }, { upsert: true, new: true, session });
    const actor = await User.findById(req.user._id).session(session);
    if (!actor) fail("Your session expired. Please sign in.", 401);
    if (administrative && actor.role !== "ADMIN") fail("Administrator access required.", 403);
    const user = await User.findById(id).select("+passwordHash").session(session);
    if (!user) fail("User account not found.", 404);
    const oldName = user.fullName;
    const oldRole = user.role;
    const availability = req.body.availability || user.availability || "AVAILABLE";
    if (!["AVAILABLE", "BUSY", "AWAY"].includes(availability)) fail("Choose Available, Busy, or Away.");
    user.availability = availability;
    if (administrative) {
      const email = text(req.body.email, "Email").toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail("Enter a valid email.");
      const role = text(req.body.role, "Role");
      if (!["ADMIN", "MANAGER", "EMPLOYEE"].includes(role)) fail("Choose a valid role.");
      if (String(user._id) === String(actor._id) && role !== user.role) fail("You cannot change your own administrator role.", 409);
      if (user.role === "ADMIN" && role !== "ADMIN" && await User.countDocuments({ role: "ADMIN" }).session(session) <= 1)
        fail("The last administrator cannot be demoted.", 409);
      user.email = email;
      user.role = role;
    } else if (password) {
      if (typeof req.body.currentPassword !== "string" || !req.body.currentPassword) fail("Current password is required.");
      const current = await hashPassword(req.body.currentPassword || "", user.passwordHash.split(":")[0]);
      if (!timingSafeEqual(Buffer.from(current), Buffer.from(user.passwordHash))) fail("Current password is incorrect.", 400);
    }
    Object.assign(user, names);
    if (password) user.passwordHash = await hashPassword(password);
    await user.save({ session });
    await ServiceVan.updateMany({ $or: [
      { driverId: String(user._id) },
      { driverId: { $in: ["", null] }, driverName: { $in: [oldName, `${oldName} (${oldRole})`] } },
    ] }, { $set: { driverName: user.fullName } }, { session });
    if (password || oldRole !== user.role) {
      const filter = { userId: user._id };
      if (String(user._id) === String(actor._id)) filter._id = { $ne: req.loginSession._id };
      await Session.deleteMany(filter, { session });
    }
    return json(user);
  });
}
