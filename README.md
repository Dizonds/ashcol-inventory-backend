# ASHCOL Inventory Backend

Express and MongoDB API for ASHCOL warehouse inventory and service operations. The API supports authenticated accounts, role-based access, stock movements, material requests, job orders, service vehicles, suppliers, and live updates.

## Requirements

- Node.js **20.19+ or 22.12+** and npm.
- MongoDB Atlas or MongoDB configured as a replica set. Inventory operations use multi-document transactions.
- The separate ASHCOL Inventory frontend for the browser interface.

## Getting started

Run commands from `ashcol-inventory-backend`. Choose the dependency installation step that matches your situation:

| Situation | What to run |
| --- | --- |
| Fresh clone with no `node_modules` folder | `npm ci` installs the exact dependency versions in `package-lock.json`. |
| `node_modules` already exists and you want a fresh, consistent installation | `npm ci` automatically deletes and recreates `node_modules`. You do not need to delete it manually. |
| Dependencies are already installed and you are just restarting the backend | Skip installation and run `npm start` or `npm run dev`. |
| You are adding or updating dependencies, or `package-lock.json` is missing | Use `npm install` (or `npm install <package-name>` to add a package). Commit the updated dependency files when changing packages. |

`npm ci` means **clean install**. It leaves `package.json` and `package-lock.json` unchanged and fails if they do not match. If that happens after pulling changes, check that you have the matching versions of both files. If you intentionally edited dependencies in `package.json`, run `npm install` to update the lockfile.

For a fresh clone:

```powershell
npm ci
Copy-Item .env.example .env
```

Copy `.env.example` only when you do not already have a `.env` file; keep your existing configuration when reinstalling dependencies or restarting. For a new installation, follow the database setup below before starting the API:

```powershell
npm start
```

For automatic restarts when you edit backend files, use `npm run dev` instead.

**Recommended startup order:**

1. Ensure your MongoDB database is running and accessible.
2. In the backend folder, run `npm start` and wait for `Inventory server running on port 3001`. Keep this terminal running.
3. Open another terminal in `ashcol-inventory-frontend` and run `npm start`.
4. Open **http://localhost:3000** in your browser.

Starting the backend before the frontend helps avoid temporary `ECONNREFUSED` proxy errors while the frontend waits for the API.

The default API address is **http://localhost:3001**. `GET /api/health` reports the database connection status. The frontend runs separately on port **3000**.

## Database setup after cloning or syncing

Cloning or pulling from GitHub downloads the application code and demo catalog templates, not another person's MongoDB records. Pulling code updates does not erase your existing database. Your `.env` file and database backups are also excluded from Git.

For a first installation on a new computer:

1. Set up a local MongoDB replica set or use MongoDB Atlas. Installing npm dependencies does not install or start your database.
2. Copy `.env.example` to `.env` if you have not already done so. Set `MONGO_URI` to your database connection string. The example uses a local replica set named `rs0` on port `27017`.
3. Set your own `ADMIN_EMAIL`, `ADMIN_PASSWORD` (10–200 characters), and `ADMIN_NAME` in `.env`, then create the first administrator:

   ```powershell
   npm run bootstrap
   ```

   Bootstrap requires a database without accounts and creates the administrator for `LOCAL-WAREHOUSE`. Remove `ADMIN_PASSWORD` from `.env` afterward. Sign in using the credentials you chose; there are no built-in login credentials.

4. Optionally populate an empty inventory with sample products, suppliers, and two months of generated stock movements:

   ```powershell
   # Want demo data? Run this to populate the system with sample products,
   # suppliers, and two months of stock movements. Requires an empty inventory.
   npm run seed:demo-two-months
   ```

   This command uses the tracked templates in `demo-data/`. It preserves existing accounts and refuses to seed an inventory that already contains products or movement history. Skip it if you want to enter your own inventory through the application.

5. Run `npm start` in the backend, wait for its ready message, then run `npm start` in the frontend in another terminal.

To use the exact records from an existing installation, restore a separately provided database backup into your own MongoDB, or obtain authorized access to the same shared database and configure `MONGO_URI` accordingly. The demo seed generates sample inventory; it does not reproduce the original accounts, sessions, or full database. If the connected database already has accounts and inventory, skip bootstrap and demo seeding.

See [Setup](docs/SETUP.md) for environment details and [Maintenance scripts](docs/SCRIPTS.md) for demo seed behavior.

## Commands

| Command | Purpose |
| --- | --- |
| `npm start` | Start the API |
| `npm run dev` | Start with automatic restarts |
| `npm run bootstrap` | Provision the first administrator on a database without accounts |
| `npm run seed:demo-two-months` | Populate an empty inventory with sample products, suppliers, and two months of movements |
| `npm run check` | Syntax-check source, scripts, and tests |
| `npm test` | Run all four automated test suites |
| `npm run test:qa` | Run browser workflows against disposable databases |
| `npm run test:browser` | Run the general browser workflow suite |
| `npm run test:live` | Verify live updates across browser sessions |

Optional migrations and demo commands are documented in [Maintenance scripts](docs/SCRIPTS.md). They are separate from normal startup.

## Repository structure

```text
ashcol-inventory-backend/
├── docs/                  Setup, architecture, and API notes
├── demo-data/             Product and supplier templates for the demo seed
├── scripts/
│   ├── setup/             Administrator bootstrap
│   ├── migrations/        Legacy data migrations
│   ├── demo/              Optional demo seed
│   └── qa/                Browser integration checks
├── src/
│   ├── database/          Models and database initialization
│   ├── security/          Authentication and account management
│   ├── routes/            Domain API routes
│   ├── services/          Logo lookup, live updates, and numbering
│   ├── utils/             Shared validation and transaction helpers
│   ├── app.js             Express middleware and route composition
│   └── index.js           Database connection and server startup
└── test/                  Node.js unit and integration tests
```

## Verification

```powershell
npm run check
npm test
```

Integration tests create temporary MongoDB replica sets. The first run may download a MongoDB test binary. Browser checks also require an installed browser and a production frontend build; see [Setup](docs/SETUP.md).

Environment files, installed dependencies, database snapshots, and generated test artifacts are excluded from source control. See [Architecture](docs/ARCHITECTURE.md), [Brand logo API](docs/brand-logo-api.md), and [Live updates](docs/live-updates.md) for implementation details.
