import "dotenv/config";
import mongoose from "mongoose";
import app from "./app.js";
import { initializeDatabase } from "./setup.js";

const PORT = process.env.PORT || 3001;
const MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27018/ashcol_inventory?replicaSet=rs0";

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
        "\nCould not connect to MongoDB replica set 'rs0' on port 27018.\n" +
        "Ensure the local MongoDB replica set is running:\n" +
        "  Run: npm run mongo  (or double-click start-db.bat)\n"
      );
    }
    process.exit(1);
  }); 
