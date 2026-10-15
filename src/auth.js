import { randomBytes, scrypt, timingSafeEqual, createHash } from "node:crypto";
import { Router } from "express";
import { User, Session } from "./models.js";
import { fail, text, json } from "./helpers.js";

// Security exception to the lesson scope: never store plain-text passwords.
export function hashPassword(password, salt = randomBytes(16).toString("hex")) {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, (error, key) => {
      if (error) reject(error);
      else resolve(`${salt}:${key.toString("hex")}`);
    });
  });
}
export function tokenHash(token) {
  return createHash("sha256").update(token).digest("hex");
}
export function authenticate(req, res, next) {
  const token = (req.headers.authorization || "").replace(/^Bearer /, "");
  if (!token) return res.status(401).json({ error: "Please sign in." });
  Session.findOne({
    tokenHash: tokenHash(token),
    expiresAt: { $gt: new Date() },
  })
    .populate("userId")
    .then((session) => {
      if (!session || !session.userId)
        fail("Your session expired. Please sign in.", 401);
      req.user = session.userId;
      req.loginSession = session;
      next();
    })
    .catch(next);
}
export function manage(req, res, next) {
  if (!["ADMIN", "MANAGER"].includes(req.user.role))
    return res
      .status(403)
      .json({ error: "A manager must perform this action." });
  next();
}
export function admin(req, res, next) {
  if (req.user.role !== "ADMIN")
    return res.status(403).json({ error: "Administrator access required." });
  next();
}
export const authRouter = Router();
const attempts = new Map();
authRouter.post("/login", (req, res, next) => {
  const key = req.ip;
  let attempt = attempts.get(key);
  if (!attempt || attempt.until < Date.now()) {
    if (attempts.size > 10000) attempts.clear();
    attempt = { count: 0, until: Date.now() + 15 * 60 * 1000 };
    attempts.set(key, attempt);
  }
  attempt.count += 1;
  if (attempt.count > 20)
    return res
      .status(429)
      .json({ error: "Too many login attempts. Try again in 15 minutes." });
  let user;
let password;
  Promise.resolve()
    .then(() => {
      const email = text(req.body.email, "Email").toLowerCase().trim();
      password = typeof req.body.password === "string" ? req.body.password : "";
      if (!password.trim()) fail("Password is required.");
      if (/\s/.test(password)) fail("Password cannot contain spaces.");
      return User.findOne({ email }).select("+passwordHash");
    })
    .then((found) => {
      user = found;
      if (!user) fail("Invalid email or password.", 401);
      return hashPassword(password, user.passwordHash.split(":")[0]);
    })
    .then((hash) => {
      if (!timingSafeEqual(Buffer.from(hash), Buffer.from(user.passwordHash)))
        fail("Invalid email or password.", 401);
      const token = randomBytes(32).toString("hex");
      return Session.create({
        tokenHash: tokenHash(token),
        userId: user._id,
        expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000),
      }).then(() => {
        attempts.delete(key);
        res.json({ token, user: json(user) });
      });
    })
    .catch(next);
});
authRouter.get("/me", authenticate, (req, res) => res.json(json(req.user)));
authRouter.post("/logout", authenticate, (req, res, next) => {
  Session.deleteOne({ _id: req.loginSession._id })
    .then(() => res.json({ success: true }))
    .catch(next);
});
