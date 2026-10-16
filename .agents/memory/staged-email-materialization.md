---
name: Staged-email materialization
description: How staged free-discovery emails become contacts, and why they are written unlinked and unvalidated.
---

Staged emails are encrypted free_discovery_candidates rows, not contacts. A bulk path writes them through writeContact (discovery|cro03, deferred hooks) for mapped-vertical, non-DBPR canonical businesses, skipping shared/suppressed/existing addresses, max 3 per business.

**Why:** createValidationIntent only succeeds for contacts already inside a canonical-preparation selection (verified business link + program enrollment intent), and the SFP typed link requires an existing valid ZeroBounce receipt. Neither can run before the contact exists, so materialized contacts are written unlinked with company_name = canonical business name and the existing link automation / canonical preparation own linking and validation.

**How to apply:** Do not call decide*BusinessLink or createValidationIntent from the materializer. Evaluate per-business gates (mapped status, DBPR) once per distinct business in MATERIALIZED CTEs; a per-row correlated effectiveBusinessVerticalStatusSql hit the 30s statement timeout. Candidate rows are never mutated; replay safety is the source-event key.
