---
name: Production seed convergence pattern
description: How this project repairs migrations whose imperative seed/backfill INSERT/UPDATE never runs in production, and how to add new seed data safely going forward.
---

## The root cause (structural, not a bug to "fix" per migration)

Production is provisioned by Replit Publish syncing `schema.ts` (DDL only). The
app's Drizzle `migrate()` runner is deliberately never pointed at production
(see `production-schema-ownership.md`). That means **any migration file's
plain `INSERT`/`UPDATE` statement — seed rows, backfills, singleton config —
silently never executes in production**, even though the table it targets
gets created correctly. This has recurred across many unrelated
tables/features because presence of the *table* looks like success; only a
content-aware check (exact key set or hash, not COUNT(*) > 0) catches it.

## The fix: one owning convergence service, not per-feature patches

`server/services/production-seed-convergence.ts` is the single place that
knows about every production-required seed/backfill write in the codebase.
It exposes:
- `runProductionSeedConvergence()` — write path, called once at startup from
  `server/index.ts`, before `registerRoutes`. Each registered target runs in
  its own `db.transaction` + Postgres advisory lock
  (`pg_advisory_xact_lock(hashtextextended(key, 1900))`), is insert-only
  (`ON CONFLICT DO NOTHING` / existence checks, never blind overwrite), and
  reports a deterministic outcome per target: `already_present | inserted |
  backfilled | conflicted | blocked | unexpected`. Any `unexpected`/`conflicted`
  throws — fail closed rather than silently accept divergent data. Writes one
  `audit_logs` summary row.
- `verifyProductionSeedConvergence()` — read-only counterpart, wired into
  both `server/services/health-monitor.ts` (`CRITICAL_CHECKS`) and the
  separate inline `/api/admin/live-health` route in `server/routes/admin.ts`
  (this project has **two** independent live-health implementations that
  must both be updated for any new check — see `live-health-dual-implementation.md`).

## Classification matters — don't build active repair for everything

Per-target classification: `schema_required_bootstrap` (fixed singleton row),
`immutable_revision_seed` (fixed versioned config row, e.g. policy v1),
`historical_backfill` (derive missing rows from other live tables' current
state, safe to run repeatedly), or exempt as `historical_one_time` /
`not_config_seed` (point-in-time repairs of data as it existed then; blindly
replaying against current data would be meaningless or actively unsafe).
Only the first three need a live convergence target in `SEED_TARGETS`; the
rest just need a documented, classified exemption — don't try to build
repair machinery for every migration that ever ran an UPDATE.

## Verified live in production (2026-08-31)

After the first deploy carrying this service, production startup logs showed
`[ProductionSeedConvergence] All 9 targets converged` with every target
`inserted` or `already_present` (none `unexpected`/`blocked`/`conflicted`),
and an `audit_logs` row `production_seed_convergence_completed`. Direct
production queries on all 10 target tables confirmed: 5 singleton/version-seed
tables (`commercial_shadow_controls`, `cro03_staging_recipes`,
`cr04_qualification_policies`, `cro03a_policy_documents`,
`cro03a_policy_control`) each hold exactly the canonical 1 row. The other 5
(`commercial_subject_revisions`, `commercial_membership_revisions`,
`cro03_provider_ledger` reservation-lineage rows, `cr06_campaign_gate_revisions`,
`inbound_request_effects`) are `historical_backfill` targets and correctly
show 0 rows in this production DB, because their live *source* tables
(`contact_business_link_decisions`, `legacy_company_mapping_decisions`,
`commercial_relationship_reviews`, `contact_identity_observations`,
`contact_merge_redirects`, `cr06_campaign_gates`, terminal
`cro03_provider_ledger` rows, equipment-order `inbound_requests`) are
themselves empty in production — 0 backfilled rows is the correct outcome,
not a failure. **When re-verifying a historical_backfill target's row count,
always check its source table's count too** — 0 is only suspicious if the
source has rows the backfill should have picked up.

## Pitfalls hit while building this

- **jsonb key order is not stable.** Comparing a stored jsonb document
  against a canonical JS object via `JSON.stringify(a) === JSON.stringify(b)`
  is fragile — Postgres round-trips do not guarantee the original key
  insertion order survives. Use a recursive key-sorted stable-stringify (or
  a real deep-equal) for content-hash/conflict-detection comparisons, not
  raw `JSON.stringify` — otherwise semantically identical content is flagged
  as a false conflict.
- **A "bootstrap the singleton row" initializer can itself assume the row
  already exists.** An initializer threw on every prod startup because it
  assumed its own control-table singleton row already existed — that row was
  itself an unreplayed migration INSERT. Any initializer reading a
  migration-seeded singleton must upsert it first (`INSERT ... ON CONFLICT
  DO NOTHING`), not just read it.
- **A multi-step data repair can be blocked in both directions by
  triggers/constraints installed by the very same historical migration.**
  When a migration installs an immutability trigger, a lineage-validating
  trigger, AND a uniqueness constraint together with its data repair, a
  *replayed* repair (run later, against a DB where all three guards are
  already active) can find that guard A requires step order X→Y while guard
  B requires the opposite order Y→X — a contradiction the original migration
  never hit because it created the guards only *after* running its repair.
  The fix generalizes past the specific tables involved: any convergence
  repair that touches a table with its own installed triggers/indexes must
  drop every guard that could observe an inconsistent intermediate state
  (not just the one that blocked the first error encountered), run the full
  repair, then recreate all of them and verify — inside one transaction so a
  thrown error rolls back the drops too. Finding one blocking guard by trial
  and error and stopping there is not sufficient; enumerate every guard
  object on the target table before writing the repair.
- **A CI table-level registration check is not granular enough for
  versioned/keyed seed data.** Registering "this table has a convergence
  target" lets a later migration silently insert a *new* key/version into
  that same table (e.g. a v2 policy row) that the convergence code has no
  logic to produce — the table-level check still passes. Seed-registration
  guards for `immutable_revision_seed`-style tables need to pin the exact
  natural-key values the convergence code actually handles, and fail when a
  migration's literal insert uses a key combination outside that set.
- **A regex-based migration-file scanner must handle quoted SQL identifiers
  (`UPDATE "table"`) as well as bare ones**, or writes against quoted tables
  silently escape detection entirely — neither registered nor exempted, and
  no failure reported either. Always test the parser against every quoting
  style actually used across the migration set, not just the common case.
- **A health check that only confirms non-emptiness (COUNT(*) > 0, or a
  truthy pointer column) can stay green after the canonical row is deleted
  and replaced with different content**, or after a foreign-key pointer is
  redirected to a non-canonical row. For `immutable_revision_seed` targets,
  verify exact natural-key sets or a content hash, and prove it by writing a
  test that deletes/substitutes the canonical row (bypassing any immutability
  trigger via table-owner `ALTER TABLE ... DISABLE TRIGGER` for the duration
  of the test only) and asserting the check flips to critical.
- Any repair like this needs an integration test that exercises it against a
  database with the **real** guard triggers/constraints already installed
  (not a bare table with no guards) — that is the only way to catch the
  cross-guard ordering contradiction above; a green test against unguarded
  columns proves nothing about the guarded production case.
- During rolling publication, live consumers retain shared policy-row pins.
  Insert-only startup verification must use compatible shared locks for
  existing policy/control rows, not exclusive locks merely to inspect them.
  **Why:** An otherwise healthy new build waited thirty seconds on policy
  verification, failed its sole startup seed target and never opened the port.
  Other red worker logs belonged to the still-serving prior process and were
  not evidence that the new build had started.
  **How to apply:** Preserve policy-before-document ordering, exact content
  verification and fatal mismatch handling. Already-selected newer policies
  need only a pinned read; actual seed-policy upgrades still acquire an
  exclusive lock in a fresh transaction and re-read all original conditions.
  Do not fix publication by making startup return healthy before guards pass.
</content>
