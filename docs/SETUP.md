# Backend setup

## Database and environment

Install the dependencies with `npm ci`. For a new installation, copy `.env.example` to `.env` and configure these values:

| Variable | Purpose |
| --- | --- |
| `MONGO_URI` | Inventory database connection string; use Atlas or a replica set |
| `PORT` | API port; use `3001` for the normal local setup |
| `CLIENT_ORIGINS` | Comma-separated allowed frontend origins; normally `http://localhost:3000` |
| `ADMIN_EMAIL` | Email for first-administrator provisioning |
| `ADMIN_PASSWORD` | Initial administrator password, 10–200 characters |
| `ADMIN_NAME` | Initial administrator display name |

The example database URI uses a local replica set named `rs0` on port `27017`. Match the host, port, and replica set to your installation. Standalone MongoDB does not support the inventory transactions. Configure the database service through your MongoDB installation or hosting provider.

Keep `.env` private. Frontend configuration needs the API URL, not the MongoDB connection string or administrator password.

## First administrator

On a database without accounts, set your own administrator email and password, then run:

```powershell
npm run bootstrap
```

Bootstrap creates an administrator for `LOCAL-WAREHOUSE` and refuses to overwrite existing accounts. Remove `ADMIN_PASSWORD` from `.env` afterward. Additional accounts are managed through the application. There are no built-in login credentials.

## Start the API

```powershell
npm run dev
```

Use `npm start` when automatic restarts are unnecessary. Open `http://localhost:3001/api/health` to check connectivity; a connected database returns `{ "ok": true }`.

Startup validates transaction support, creates required indexes, initializes brands when absent, and assigns missing historical request/transfer references. Legacy stock without a branch assignment must be migrated before startup. See [Maintenance scripts](SCRIPTS.md).

In a separate terminal, run `npm start` from `ashcol-inventory-frontend`. Keep the frontend on port 3000 and the API on port 3001. Press Ctrl+C in each terminal to stop its server.

## Automated checks

```powershell
npm run check
npm test
```

`check` verifies JavaScript syntax; it is not a linter. Tests run serially using isolated temporary databases. Migration and seed subprocess tests override the database URI to keep their writes in those temporary databases.

## Browser workflows

First run `npm run build` from `ashcol-inventory-frontend`. Then, from the backend:

```powershell
npm run test:qa
```

The checks use disposable databases and serve the sibling frontend's `client/build`. They do not load the backend `.env`. The default browser is Microsoft Edge at its standard Windows installation path.

- Set `BROWSER_PATH` if the browser executable is elsewhere.
- Set `FRONTEND_BUILD_DIR` if the frontend build is elsewhere.
- Evidence is written beneath the ignored backend `artifacts/qa` directory.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| MongoDB connection fails | Database service, URI, host, port, and replica-set name |
| Startup rejects transaction support | Configure a replica set or Atlas |
| Startup reports legacy inventory | Review and run the branch-assignment migration |
| Browser cannot reach the API | Backend port 3001, frontend proxy, and allowed origins |
| Browser QA reports a missing build | Build the frontend or set `FRONTEND_BUILD_DIR` |
