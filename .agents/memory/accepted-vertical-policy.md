---
name: Accepted-vertical policy
description: How a business vertical becomes accepted (policy_accepted tier) from one clear business-specific source, and the supersession rules.
---
- One clear source suffices: own website service description, identity-matched listing category, both, or an AI proposal whose quoted text is verifiably in retained evidence. Name, generic keyword ("health"), unsupported label, bare AI confidence never qualify; reliable disagreement is recorded as ACCEPTANCE_CONFLICT, not forced.
- AI result and acceptance decision are distinct: AI `target` rows keep tier NULL unless the citation verifies. Never mark all AI targets `resolved_high`.
- Evidence rows carry an input fingerprint over vertical/industry fields only (not name/geography/domain). Website-based acceptance is additionally bound to the website host. Changed inputs supersede the decision; a cached older row that must become latest again is re-recorded as an insert-only reaffirmation row.
- Selection treats a fingerprinted row as "settled" only if current AND the latest completed row; legacy rows without fingerprint keep the old rule.
- A failed website fetch is provisional/retryable, never non-target.

**Why:** the user's attached policy: single source is enough, no manual approval for ordinary incomplete cases, classification stays separate from outreach eligibility.
**How to apply:** change phrase tables or rules => bump SFP_VERTICAL_ACCEPTANCE_POLICY_VERSION (part of evidence hash). Disposable cert: vertical-acceptance-policy. Six other certs (canonical-flow-progression, automatic-continuity, legacy-sfp-cohort, legacy2001, integrated-pipeline, crm-repair-v2) fail identically on unmodified HEAD; compare to baseline before blaming this work.
