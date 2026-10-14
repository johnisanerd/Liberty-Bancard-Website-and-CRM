---
name: DB connection pool saturation from background worker count
description: Why the dev app can show system-wide 500s/timeouts on unrelated endpoints even when Postgres itself is healthy, and how to tell the difference from a real regression.
---

## Symptom
Every request (including completely unrelated endpoints, and both authenticated and anonymous ones) starts failing with Drizzle/pg errors like "timeout exceeded when trying to connect" or "Connection terminated due to connection timeout", while background BullMQ workers simultaneously log the same errors for unrelated queues (ghl-sync, sunbiz-cron, enrichment, chargeback-commands, etc). This can persist for many minutes and survive a full workflow restart.

## Diagnosis, not a universal root cause
Background work and HTTP requests can compete for the same application pool.
Historical worker contention caused apparently unrelated endpoint failures even
though an independent connection to PostgreSQL was fast. Restarting can worsen
this by synchronizing worker startup; it is not a reliable remedy.

**Why:** A previous pool-exhaustion incident looked like widespread application
regressions. Later live idle-transaction failures occurred with unused pool slots
and no acquisition wait, so that earlier diagnosis must not be assumed for all
slow-worker incidents.

**How to apply:** Compare actual acquisition waits, idle slots and cross-route
errors with an isolated read-only connection. Distinguish defined queues,
selected workers, active jobs and actual database/CPU demand; do not reuse
historical worker-count assumptions. Review cadence versus observed run duration
and preserve HTTP headroom. Consider more connections only after establishing
pool exhaustion, not as a remedy for idle-transaction termination or slow
process scheduling.
