import express from "express";
import cors from "cors";
import mongoose from "mongoose";
import { authRouter, authenticate } from "./auth.js";
import directory from "./routes/directory.js";
import inventory from "./routes/inventory.js";
import requests from "./routes/requests.js";

const app = express();
app.disable("x-powered-by");
app.use(
  cors({
    origin: (process.env.CLIENT_ORIGINS || "http://localhost:3000")
      .split(",")
      .map((s) => s.trim()),
  }),
);
app.use(express.json({ limit: "32kb" }));
app.get("/api/health", (req, res) => {
  const ok = mongoose.connection.readyState === 1;
  res.status(ok ? 200 : 503).json({ ok });
});
app.use("/api/auth", authRouter);
app.use("/api", authenticate, directory, inventory, requests);
app.use((req, res) => res.status(404).json({ error: "Endpoint not found." }));
app.use((error, req, res, next) => {
  if (error.code === 11000)
    return res
      .status(409)
      .json({
        error:
          "That SKU already exists in this branch (including archived items), or the account/name already exists.",
      });
  if (error.name === "ValidationError" || error.name === "CastError")
    return res.status(400).json({ error: error.message });
  const status = error.status || 500;
  if (status === 500) console.error(error.message);
  res
    .status(status)
    .json({
      error:
        status === 500
          ? "The operation could not be completed. No partial stock transaction was saved."
          : error.message,
    });
});
export default app;
