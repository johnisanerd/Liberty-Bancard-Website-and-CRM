---
name: Disposable pre-deploy database setup
description: Local PostgreSQL setup details needed when running the full pre-deploy gate under a supervised workflow.
---

Use a disposable PostgreSQL cluster under `/tmp` for the full pre-deploy gate, with an explicit local Unix socket directory and explicit cluster-owner role. Keep the database port separate from the application port because supervised Replit workflows may inject both `PGUSER` and a dynamic `PORT`.

**Why:** The environment's default PostgreSQL socket directory may not exist, the client may default to a role that `initdb` did not create, and the workflow can inject a dynamic app port that collides with the disposable database.

**How to apply:** Set PostgreSQL to use `-k /tmp`, create/connect as the `initdb` owner, and use a `DB_PORT` shell variable rather than `PORT` for PostgreSQL. Run `postgres` itself as a managed background shell task; a daemon started by a foreground setup shell may be reaped when that shell exits (confirmed again: `pg_ctl start`'s detached postmaster died between shell invocations even though `pg_ctl status` reported it running — only a `ShellExec run_in_background: true` postgres process survived). Use a URL with a valid hostname plus `?host=%2Ftmp` so both `pg` and the certification URL parser accept the socket connection. Set the app's exported port explicitly, pass matching `DATABASE_URL` and `TEST_DATABASE_URL` with `NODE_ENV=test`, and restore the original workflow command after the run.

Do not rely on `export`/`source .env` inside a ShellExec command to override `DATABASE_URL` for a disposable-DB run — the shell's per-command env sync silently reverts it back to the real dev DB before node/tsx reads it. Instead prefix the exact command with inline `VAR=value` assignments in one simple command (e.g. `DATABASE_URL=... TEST_DATABASE_URL=... NODE_ENV=test npx tsx script.ts`), which does survive.

The disposable DB's name must itself satisfy `isClearlyDisposableName()` in `scripts/test-infrastructure-guard.ts` (must start with `test`/`ci` or have `test`/`ci` set off by `_`/`-`): a name like `sfp2001test` fails this even though it "looks like a test DB" — use `test_sfp2001` or similar. To seed the schema into a fresh disposable DB, prefer `npx tsx scripts/migrate.ts` (idempotent, no prompts) over `drizzle-kit push`, since `push` can hit an interactive destructive-constraint prompt that fails even under `yes |` (the prompt library hard-requires a real TTY, not just readable stdin).

Use a freshly migrated disposable database for a full certification retry after a failed cohort suite. Do not start the application against that database while its integration suites are running.

**Why:** Failed suites can retain eligible synthetic businesses and global package state; later frozen selections can include those leftovers. Application startup also performs classification reconciliations even with background jobs off.

**How to apply:** Allocate a new test database and Redis namespace for the retry. Keep browser and server-startup checks on separate disposable databases, and bind clean-checkout receipts to the tested commit.

Run large native intake/serving-volume and multi-workbook certificates
sequentially in a background shell when the foreground command budget is
insufficient. A foreground deadline is not an assertion failure or a completed
certificate.

**Why:** Parallel migrated-database certificates exceeded the five-minute
foreground limit; the same certificates completed successfully when run
sequentially without that deadline.

**How to apply:** Monitor the final exit result, inspect each certificate's
completion output and verify disposable cleanup before claiming a pass.
