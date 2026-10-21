---
name: Enrichment funnel blockers
description: Verified reasons linked contacts and websites-bearing businesses stay unclassified or unprepared; use before trusting audit projections
---
- Businesses with a website but no completed classification evidence are mostly deferred by the geography gate (unknown location or outside the three-county territory), not waiting for a sweep. Classification items store the route in outcome_code text.
- The free sweep's gap check skips businesses that already have a classification item, so geography-routed businesses only return via the geography recovery step.
- About 73% of the priority preparation candidate set was suppressed (email_status invalid, no valid observation); screening them before qualification is lossless. Qualification costs about 2-3 s per contact in production.
**Why:** an audit claimed a stored-vertical pass would unblock 3,227 contacts; per-contact blockers disproved it.
**How to apply:** establish each contact's real blocker (link, location, vertical, suppression, validation) before predicting an unlock; read prod timings from `[CanonicalRecipientPreparation]` logs (`qual_*`, `tx_*` keys).
