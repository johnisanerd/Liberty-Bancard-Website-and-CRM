---
name: Enrichment funnel blockers
description: Verified reasons linked contacts and websites-bearing businesses stay unclassified or unprepared; use before trusting audit projections
---
- Businesses with a website but no completed classification evidence are mostly deferred by the geography gate (unknown location or outside the three-county territory), not waiting for a sweep. Classification items store the route in outcome_code text.
- The free sweep's gap check skips businesses that already have a classification item, so geography-routed businesses only return via the geography recovery step.
- About 73% of the priority preparation candidate set was suppressed (email_status invalid, no valid observation); screening them before qualification is lossless. Qualification costs about 2-3 s per contact in production.
**Why:** an audit claimed a stored-vertical pass would unblock 3,227 contacts; per-contact blockers disproved it.
**How to apply:** establish each contact's real blocker (link, location, vertical, suppression, validation) before predicting an unlock; read prod timings from `[CanonicalRecipientPreparation]` logs (`qual_*`, `tx_*` keys).

## Validation, role addresses and legacy holds (observed 2026-10)
- Address claims for a ZeroBounce call that timed out after dispatch stay held on purpose; releasing them is a possible re-charge and an owner decision. The open validation queue is small, so validation order is not the bottleneck.
- Every settled role-local-part address (info@, contact@) came back invalid; ZeroBounce sub-status is not stored, so persisting it (new column) is the prerequisite for any role-address policy.
- Domain match alone never links a legacy contact; 10.6k held Sunbiz claims are contactless prospects; a business-only completion tick now creates their canonical businesses (original claim untouched, cursor-based, kill switch env).
**Why:** these were the items the first pass left out; the findings show what each needs.
**How to apply:** do not re-derive; start from the needed prerequisite listed per item.
