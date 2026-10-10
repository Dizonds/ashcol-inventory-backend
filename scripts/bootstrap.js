import "dotenv/config";
import mongoose from "mongoose";
import { User, Branch } from "../src/models.js";
import { hashPassword } from "../src/auth.js";
import { initializeDatabase } from "../src/setup.js";

const email = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();
const password = process.env.ADMIN_PASSWORD || "";
const branchId = process.env.ADMIN_BRANCH_ID || "LOCAL-WAREHOUSE";
if (
  !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
  password.length < 10 ||
  password.length > 200
) {
  console.error(
    "Set ADMIN_EMAIL and ADMIN_PASSWORD (10–200 characters) in server/.env first.",
  );
  process.exitCode = 1;
} else {
  mongoose
    .connect(
      process.env.MONGO_URI || "mongodb://127.0.0.1:27017/ashcol_inventory",
      { autoIndex: false },
    )
    .then(initializeDatabase)
    .then(() => User.countDocuments())
    .then((count) => {
      if (count)
        throw new Error(
          "Accounts already exist. Sign in as an administrator to create more; bootstrap does not overwrite accounts.",
        );
      return Branch.findById(branchId);
    })
    .then((branch) => {
      if (!branch)
        throw new Error("ADMIN_BRANCH_ID does not match a configured branch.");
      return hashPassword(password);
    })
    .then((passwordHash) =>
      User.create({
        email,
        passwordHash,
        fullName: process.env.ADMIN_NAME || "Inventory Administrator",
        role: "ADMIN",
        branchId,
      }),
    )
    .then(() =>
      console.log(
        "Administrator created. Remove ADMIN_PASSWORD from .env after setup.",
      ),
    )
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    })
    .finally(() => mongoose.disconnect());
}
