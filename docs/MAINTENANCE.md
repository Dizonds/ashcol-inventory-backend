# Repository maintenance

## Submission cleanup

- Grouped runtime modules into database, security, routes, services, numbering, and utilities.
- Grouped setup, migration, demo, and browser QA scripts by purpose.
- Updated imports, package commands, test subprocess paths, and demo-template resolution.
- Updated browser workflows to use the current frontend build path and keep generated evidence in the backend's ignored artifacts folder.
- Added a shared browser-path configuration and application-route fallback for direct page reloads.
- Added a root README, current setup and architecture guides, script documentation, and editor/Git text conventions.
- Retained all four test files, runtime dependencies, active routes, and the required demo templates.

Old database archives, recovery snapshots, machine-specific launchers, duplicate documentation, obsolete scripts, and unneeded demo exports were moved to a private backup directory outside this repository. The existing local `.env` and installed dependencies remain available for development and are excluded from Git.

Existing Git history and index changes were preserved. Removing a file from the working tree does not remove it from historical commits.

## Verification

```powershell
npm run check
npm test
npm run test:qa
```

The browser checks require a built sibling frontend and an installed browser. Their databases are disposable; no live inventory database is needed for these checks.

## Cleanup verification

Verified on October 19, 2026:

- Syntax checks passed for all 32 retained JavaScript files.
- All 83 automated tests passed, including migration and demo-seed integration tests.
- The clean-install dry run passed with the updated lockfile.
- Static checks found no missing relative imports, unreachable runtime modules, or broken local documentation links.
- The reorganized server started on port 3001; direct and frontend-proxied health checks returned successful responses.
- Browser test maintenance updated the stock-operation selector to use its visible label and the theme action to use the current profile menu.
- All four browser workflow suites passed: general QA, request fulfillment, job orders, and live updates. The live-update check now uses administrator and manager sessions for supplier pages while retaining technician checks for vehicle assignment and permissions.
