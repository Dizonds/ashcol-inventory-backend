# ASHCOL Inventory Backend

Express and MongoDB API for ASHCOL warehouse inventory and service operations. The API supports authenticated accounts, role-based access, stock movements, material requests, job orders, service vehicles, suppliers, and live updates.

## Requirements

- Node.js **20.19+ or 22.12+** and npm.
- MongoDB Atlas or MongoDB configured as a replica set. Inventory operations use multi-document transactions.
- The separate ASHCOL Inventory frontend for the browser interface.

## Getting started

Run commands from `ashcol-inventory-backend`:

```powershell
npm ci
Copy-Item .env.example .env
```

For a new installation, configure `.env` to match your database. Keep an existing `.env` when restarting an installation. Provision the first administrator using [Setup](docs/SETUP.md), then start the API:

```powershell
npm run dev
```

The default API address is **http://localhost:3001**. `GET /api/health` reports the database connection status. Run the frontend separately on port **3000**.

## Commands

| Command | Purpose |
| --- | --- |
| `npm start` | Start the API |
| `npm run dev` | Start with automatic restarts |
| `npm run bootstrap` | Provision the first administrator on a database without accounts |
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
