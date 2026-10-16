---
name: Email "validated" definition and send authority
description: What contacts.email_status 'valid'/'active' mean, which freshness window applies, and what actually authorizes a marketing send.
---
- Send authority is a fresh provider observation (evaluateMarketingEmailEligibility, 30-day window via EMAIL_VALIDATION_MAX_AGE_MS). contacts.email_status is only a compatibility projection and cannot authorize a send.
- 'valid' without email_validation_updated_at is legacy/anomalous; it counts as unvalidated (UNVALIDATED_EMAIL_PREDICATE) and a migration returned the existing rows to 'unvalidated'.
- 'active' (~152k historical_backfill rows) is the old default, treated as unvalidated everywhere; do not bulk-relabel it (many predicates and the sequence worker already treat it identically).
- Reporting code (contact-census-classifier, contact-quality-signals) calls 'valid' current for 90 days, while marketing needs 30; that mismatch is unresolved policy, not a bug fix.
- Prefilter (DNS/bounce) already runs at the point of spend for any contact, so unlinked backfill contacts need no sweep.

**Why:** an earlier answer wrongly implied a 90-day re-check and that the sequence worker's status check was the gate; the durable observation path is the real gate.
**How to apply:** use currentValidEmailPredicate(alias) for candidate selection of validated contacts; never select on bare email_status='valid'.
