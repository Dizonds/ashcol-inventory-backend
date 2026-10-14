# ASHCOL demo data

This package contains a snapshot of the demo database, including 7 service vehicles,
21 products, 70 stock movements, 13 brands, 6 suppliers, 1 material request, and
3 demo user accounts. MongoDB IDs, dates, password hashes, and indexes are preserved.
Active login sessions are excluded. See manifest.json for the export date and counts.

## Import on another computer

1. Extract ASHCOL-demo-data.zip.
2. Install MongoDB and MongoDB Database Tools (which provides mongorestore).
   The inventory app requires a MongoDB replica set or Atlas for stock transactions.
3. Open a terminal in the extracted folder. With local MongoDB running, execute:

   ```powershell
   mongorestore --uri="mongodb://127.0.0.1:27017" --gzip --archive="ashcol-demo.archive.gz" --nsFrom="ashcol_inventory.*" --nsTo="ashcol_demo.*"
   ```

   This imports into a separate database named ashcol_demo. Use an empty database;
   rerunning against an existing database may produce duplicate ID errors.
   If mongorestore is not on PATH in Windows, use:

   ```powershell
   & "C:\Program Files\MongoDB\Tools\100\bin\mongorestore.exe" --uri="mongodb://127.0.0.1:27017" --gzip --archive="ashcol-demo.archive.gz" --nsFrom="ashcol_inventory.*" --nsTo="ashcol_demo.*"
   ```

4. In the backend project's .env, set MONGO_URI to this demo database. For a local
   replica set named rs0 on port 27017:

   ```dotenv
   MONGO_URI=mongodb://127.0.0.1:27017/ashcol_demo?replicaSet=rs0
   ```

   Use your own MongoDB port and replica set name. For Atlas, use your Atlas URI
   in both the restore command and .env, with ashcol_demo as the app database.
5. Run npm install and npm start in the backend project, then start the frontend
   using the project's normal setup. This ZIP contains data, so your friend also
   needs the application code.

## Demo logins

| Role | Email | Password |
| --- | --- | --- |
| Admin | hatdog@hat.com | hatdog@hat.com |
| Manager | manager@ashcol.com | hatdog@hat.com |
| Employee | technician@ashcol.com | hatdog@hat.com |

## Refresh the export

From the backend project folder, run node scripts/export-demo-data.js. It exports
the database configured in .env without changing its data. Then zip the contents
of demo-data again.
