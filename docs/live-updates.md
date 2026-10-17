# Live updates and page persistence

Signed-in browsers connect to `GET /api/events` using a Bearer authorization
header. The server sends `ready` when connected and `change` after a successful
data-changing API request finishes. Each event contains only a revision number.
Failed requests, login requests, and transaction-ticket creation do not broadcast.

The browser reloads its permitted data in the background. Incoming bursts are
grouped over 150 milliseconds. Pages remain mounted so open panels, forms, and
filters survive. Unchanged responses retain their previous React references.
Technicians continue to receive only their assigned vehicles through the existing
role-scoped APIs.

Disconnected streams retry after two seconds. Every connection/reconnection asks
for a fresh snapshot; returning to a tab or coming back online also refreshes it.
Expired or revoked login sessions return to the login screen.

The selected navigation page is saved in `sessionStorage` under
`ashcol_inventory_page`. Reloading the tab restores that page after authentication.
Unknown pages or pages forbidden for the current role fall back to Overview.
Logging out clears the saved page.

The broadcaster runs in one backend process. Updates made through that backend
are shared between browser sessions. Direct database edits and separate backend
processes would require a shared change stream or message broker.

To verify two real browser sessions with a disposable database:

1. Build the React app with `npm run build` in `ashcolinventoryreactfinal/ashcolinventory`.
2. Run `npm run test:live` in `ashcolinventory_backend_final`.

The browser test checks vehicle assignment/unassignment, brand updates, retained
drafts, and page restoration after reload. It never loads the live database's `.env`.
