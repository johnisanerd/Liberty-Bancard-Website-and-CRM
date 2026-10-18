---
name: Accepted-vertical policy
description: How a business vertical becomes accepted (policy_accepted tier) from one clear business-specific source, and the supersession rules.
---
- One clear source suffices: own website service description, identity-matched listing category, both, or an AI proposal whose quoted text is verifiably in retained evidence. Name, generic keyword ("health"), unsupported label, bare AI confidence never qualify; reliable disagreement is recorded as ACCEPTANCE_CONFLICT, not forced.
- AI result and acceptance decision are distinct: AI `target` rows keep tier NULL unless the citation verifies. Never mark all AI targets `resolved_high`.
- Evidence rows carry an input fingerprint over vertical/industry fields only (not name/geography/domain). Website-based acceptance is additionally bound to the website host. Changed inputs supersede the decision; a cached older row that must become latest again is re-recorded as an insert-only reaffirmation row.
- Selection treats a fingerprinted row as "settled" only if current AND the latest completed row; legacy rows without fingerprint keep the old rule.
- A failed website fetch is provisional/retryable, never non-target.
- Page text is support only when it describes the business's own activity: per-clause negation ("we do not provide…"), audience/vendor phrasing ("marketing for dental practices", "SEO for plumbers") and CTA boilerplate are not support; an AI citation must also be present, non-generic, and not contradict a table vertical. The same checks apply when an existing label already resolves (label-vs-page conflict is recorded, not skipped).
- Listing-category authority is the retained identity-matched `listing_category` rows in paid candidate evidence (not discredited/quarantined), and their hashes are part of the input fingerprint. Imported `industry_primary`/`vertical` labels are not a listing source.
- Reconsideration runs inside the ordinary free continuation (automatic program only): untiered legacy targets, stale fingerprints/policy, provisional rows that never read their website, and a 30-day website recheck. Changed same-domain content is only caught at that recheck (latency up to 30 days); unsupported new content supersedes via PRIOR_WEBSITE_ACCEPTANCE_SUPERSEDED.

**Why:** the user's attached policy: single source is enough, no manual approval for ordinary incomplete cases, classification stays separate from outreach eligibility.
**How to apply:** change phrase tables or rules => bump SFP_VERTICAL_ACCEPTANCE_POLICY_VERSION (part of evidence hash). Disposable cert: vertical-acceptance-policy. Six other certs (canonical-flow-progression, automatic-continuity, legacy-sfp-cohort, legacy2001, integrated-pipeline, crm-repair-v2) fail identically on unmodified HEAD; compare to baseline before blaming this work.

## Reconsideration discovery is a bounded cursor sweep
Reconsideration finds work through a persisted keyset cursor (system_settings) over canonical business ids, with per-business LATERAL index lookups, up to 10 windows of 1,000 per tick and 25 businesses of work; never a whole-table DISTINCT ON.
**Why:** the earlier whole-table form did ~340k buffer hits per tick at 93k businesses (0.2 s warm) and grows linearly; LIMIT 25 did not bound it. The harness `reconsideration-scale` in the disposable runner measures both shapes.
**How to apply:** a due business with a current-fingerprint non-attempt is handled for 7 days (1 day if the site was unreadable), otherwise the 4.4k legacy untiered targets would refill the 25/tick budget daily. Throughput is ~25 per 10-minute tick (~3,600/day), so the 30-day recheck is a schedule, not a deadline. The escalation-pending query is still whole-set (~0.2 s, ~490k buffers at steady state); measured, not repaired.
