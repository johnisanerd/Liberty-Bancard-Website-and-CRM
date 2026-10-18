---
name: Publish vs dev environment drift
description: Non-obvious ways a published (production) Replit deployment can diverge from the dev workspace even when code looks identical — check these before trusting any dev-derived identity value against production.
---

## Git HEAD drifts past the actually-deployed commit
Replit's publish flow can auto-commit a bookkeeping commit ("Published your App") in the dev workspace *after* a publish, moving local `git rev-parse HEAD` past the commit that was actually built and deployed. Any tool that derives a "release identity" (SHA, hash, etc.) from local git HEAD will silently compute the wrong value right after every publish.

**Why:** the auto-commit is bookkeeping only — it does not change file content — but it does change the commit SHA, so anything keying off SHA (signing artifacts, release-pinned config, attestations) breaks unless corrected.

**How to apply:** before trusting a locally-derived release SHA against production, cross-check it against a live value read from the running production process itself (e.g. a diagnostic endpoint), and verify tree hash equality (`git rev-parse <sha>^{tree}`) between local HEAD and the known-good deployed commit before treating the checkout as safe to keep working from.

## Dev and production databases are genuinely separate
Even when a secret like `DATABASE_URL` appears identically named in both dev and production secret lists, they are NOT the same database. Writes made against the dev workflow's database (or via `executeSql` with its default "development" environment) never land in production.

**Why:** confirmed directly — tables that should have held recently-imported rows were completely empty when queried with `executeSql({ environment: "production" })`, despite successful-looking writes made earlier against dev.

**How to apply:** any workflow that writes data meant to satisfy a production-side check must call production's actual API/URL, not localhost or the dev workflow. Verify with a production-scoped read (`executeSql({ environment: "production" })`) rather than assuming shared storage.

## Redis can be genuinely shared between dev and production
Unlike the database, `REDIS_URL` may point to the *same* Redis instance for both dev and production. If the app's BullMQ/Redis key prefix is not environment-scoped (e.g. a helper that only special-cases `NODE_ENV=test`/`CI=true` and otherwise uses one default prefix for everything else, including both `development` and `production`), dev's live background workers publish into the same keyspace production's workers and health/fleet checks read — causing cross-environment collisions (mismatched identity/version data, false failures, or worse, duplicate job processing).

**Why:** confirmed directly — a production-side worker-fleet identity check failed only while dev's workflow was running, and passed immediately once dev was stopped, with no other change.

**How to apply:** if a production check that inspects "live worker" state via Redis fails in a way that doesn't match the actual deployed release, suspect keyspace collision with dev before assuming a deploy/config bug. The durable fix is to namespace Redis/BullMQ keys per environment (e.g. by REPL_ID or an explicit deployment identity), not to manually stop one environment during checks.

## Code can deploy without its schema change
A Publish can start the new build while production still lacks the new migration's columns (observed with the vertical-acceptance migration: new build running, new columns absent, first classification tick failed with undefined-column errors). Production startup skips migrations, so nothing repairs it automatically.
**How to apply:** after any Publish that carries a migration, read production `information_schema.columns` for the new columns before judging progress or claiming acceptance; if absent, the user must re-run or inspect the Publish database step.
