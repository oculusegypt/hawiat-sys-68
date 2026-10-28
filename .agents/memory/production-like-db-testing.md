---
name: Production-like database testing
description: Keep synthetic lifecycle, driver, and financial tests out of the project's production-like SQLite database.
---

Treat `data/sabaik.db` as production data. For requested end-to-end tests, use the real admin and driver accounts with the Replit secrets `ADMIN_PASSWORD` and `DRIVER_TEST_PASSWORD`; use the account credentials only through the secret environment, and never read, print, log, or hardcode their values. Run synthetic requests, work orders, evidence, invoices, payments, and lifecycle writes only against an isolated SQLite backup; never use the source database as a test fixture.

**Why:** The user wants tests to exercise the full system with actual admin and driver accounts while protecting the production-like database and credentials.

**How to apply:** For role/auth coverage, use the named Replit secrets with the corresponding real accounts. For synthetic lifecycle or financial scenarios, use a consistent isolated SQLite copy, verify key counts before and after, clearly label test data, and remove the temporary copy after verification. Never put secret values in files, test output, or reports.
