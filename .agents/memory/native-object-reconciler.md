---
name: Automatic native object reconciler
description: Production startup installs reviewed PL/pgSQL functions and triggers that Publish does not deliver; how to add entries and what it must never do.
---

Publish applies tables/columns/indexes/FKs only. Functions and triggers are installed at production startup by a manifest-driven reconciler (server/native-objects), right after the "startup migrations skipped" notice and before workers. Each manifest entry is generated from reviewed migrations, run in one transaction under a session advisory lock, preceded by its own preflight (refuse on drift or missing Publish prerequisites), skipped when a read-only verification already passes, and never throws into startup. A refused or failed entry leaves dependent guards fail-closed and is audited. Kill switch: NATIVE_OBJECT_RECONCILE=off.

**Why:** the user said "I don't want to have to manually run SQLs all the time" after being told Publish cannot deliver function bodies/triggers. This supersedes the earlier "owner console only" workflow for new entries; the console files remain a manual fallback.

**How to apply:** For a new native object, add a generator-produced manifest entry with preflight + verification SQL (never edit applied migrations), and certify install, replay, drift refusal, missing prerequisites, lock contention and concurrent replicas in a disposable DB. Do not replay the Drizzle journal at production startup (collides with Publish-created relations). Never weaken a guard to make an install succeed; a drift refusal needs human review.
