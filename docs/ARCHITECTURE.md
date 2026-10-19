# Backend architecture

## Startup and request flow

`src/index.js` loads environment configuration, connects to MongoDB, runs database initialization, and starts Express. `src/app.js` composes CORS, JSON parsing, health checks, authentication, domain routes, live-update hooks, and error responses.

Authenticated requests use a Bearer session token. Server-side session validation and role checks control access to inventory and management operations. The browser does not access MongoDB directly.

## Responsibilities

| Directory | Responsibility |
| --- | --- |
| `database` | Mongoose model definitions, indexes, transaction-support validation, and initialization |
| `security` | Password hashing, login/logout, session validation, roles, and account updates |
| `routes` | Directory/catalog, inventory, request, and job-order endpoints |
| `services` | External logo lookup and server-sent live updates |
| `services/numbering` | Movement tickets and request, transfer, and vehicle receipt references |
| `utils` | Input validation, response formatting, stock rules, and transaction helpers |

Domain routes retain their existing workflow logic. File placement separates responsibilities without introducing additional controller or repository layers.

## Data integrity

Stock operations use MongoDB transactions so balances and movement history change together. Validation and authorization are enforced by the API. Initialization refuses unsupported standalone databases and legacy inventory missing required branch ownership.

Migrations, bootstrap, and demo seeding are explicit operational commands. Tests exercise them against disposable replica sets rather than the configured inventory database.

## Tests and tools

The backend uses Node.js's built-in test runner with Supertest and temporary MongoDB replica sets. Browser workflows use Playwright Core and an existing Chromium-compatible browser. Syntax verification uses `node --check` for every retained JavaScript file.

The API is a single-process Express application. Live update notifications are shared between sessions connected to that process; direct database changes and separate backend processes require additional coordination. See [Live updates](live-updates.md).
