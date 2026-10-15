---
name: Created-original recovery admission and classifier pitfalls
description: Lessons from repairing STAGING_RECIPE_DISABLED created/matched originals and the per-upload ledger
---
- Shared recovery predicate SQL needs `item`, `accounting`, `observation` aliases; any other caller (e.g. the replay-retained route) must join them or it 500s.
- Created rows cannot be bridged, so the capability hold is unreachable for them; admit retry codes only with the worker's own receipt.
- An unlinked pre-existing contact is held for corroboration unless address/phone corroborate; reuse fixtures need a pre-resolved business.
- **Why:** the row-failure classifier regex-matched Drizzle "Failed query" text, which echoes the SQL; a literal like `NATIVE_GUARD_MISSING` in a predicate made lock timeouts fatal.
- **How to apply:** never put fatal-reason literals where SQL text gets echoed into errors without checking `isRecoverableImportRowFailure`; classify on the cause, not the wrapper.
- `--audited-only`/`--identity-only` fail at "58 hold receipts" at baseline too; do not attribute it to new work.
- Ledger queries: avoid `entity_type` with `entity_key` on audit_logs (2.9s plan vs 0.19s); detoasting `import_executions.source_payload` per row is ~15ms each, read it only when no retained observation exists.
