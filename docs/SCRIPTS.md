# Maintenance scripts

Run commands from the backend root. Database maintenance commands use the configured inventory connection and may write data. Review the target database and keep a recovery backup before using a migration.

## Setup

`npm run bootstrap` runs `scripts/setup/bootstrap.js`. It creates the first administrator and refuses to run when accounts already exist. See [Setup](SETUP.md).

## Migrations

| Command | Purpose and behavior |
| --- | --- |
| `npm run migrate -- BRANCH_ID` | Assign legacy inventory to an explicitly selected branch; applies changes in a transaction |
| `npm run migrate:service-vans` | Migrate the older branch/vehicle representation; writes data and can remove legacy branch records |
| `npm run migrate:job-links` | Preview job/reference field migration; add `-- --apply` to write |
| `npm run migrate:catalog-links` | Preview optional brand/supplier lookup links; add `-- --apply` to write |

The service-vehicle migration refuses unexpected extra warehouse records unless explicitly invoked with `-- --drop-extra-warehouses`. Read the implementation before using that option.

## Demo data

`npm run seed:demo-two-months` runs `scripts/demo/seed-two-month-demo.js`. It reads the tracked product and supplier templates and creates reconciled demo movement history for two calendar months.

The seed requires an existing manager or administrator, preserves existing accounts, and refuses an inventory that already contains products or movement history. It writes a recovery snapshot to the local application-data or temporary directory before seeding.

Old reset, randomization, export, screenshot, and ad hoc review scripts were archived outside the repository. The maintained demo seed and automated checks are the supported evaluation workflows.

## QA

- `npm test`: four unit/integration test files, with isolated databases for database tests.
- `npm run test:browser`: general browser workflows.
- `npm run test:live`: live-update behavior across administrator, manager, and technician sessions.
- `npm run test:qa`: general workflows, request fulfillment, job orders, and live updates.

Browser QA shares its frontend-build configuration through `scripts/qa/environment.js`. It serves the compiled frontend with application-route fallback and stores evidence under `artifacts/qa`. See [Setup](SETUP.md) for browser and build overrides.
