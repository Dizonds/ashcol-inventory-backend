# Demo catalog templates

`products.json` and `suppliers.json` are required by `scripts/demo/seed-two-month-demo.js`. Run `npm run seed:demo-two-months` from the backend root to initialize an empty demo inventory after provisioning an administrator.

These templates are not a complete database backup. Accounts and sessions are provisioned through the backend rather than imported from historical exports. See [Maintenance scripts](../docs/SCRIPTS.md) for seed behavior and requirements.
