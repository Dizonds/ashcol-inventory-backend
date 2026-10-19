import "dotenv/config";
import mongoose from "mongoose";
import app from "./app.js";
import { initializeDatabase } from "./database/setup.js";

const PORT = process.env.PORT || 3001;
const MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/ashcol_inventory?replicaSet=rs0";

mongoose
  .connect(MONGO_URI)
  .then(() => initializeDatabase())
  .then(() => {
    app.listen(PORT, () => {
      console.log("Inventory server running on port " + PORT);
    });
  })
  .catch((err) => {
    console.error("Startup error:", err.message);
    if (err.name === "MongooseServerSelectionError") {
      console.error(
        "\nCould not connect to MongoDB using the configured MONGO_URI.\n" +
        "Check the host, port, and replica set in .env, and ensure MongoDB is running.\n"
      );
    }
    process.exit(1);
  }); 
