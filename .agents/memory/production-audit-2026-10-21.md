---
name: Production enrichment audit baseline (Oct 21 2026)
description: Dated production funnel numbers and the binding constraints found, for comparing later audits
---
- Canonical businesses ~98.9k: 21.1k with domain, 6.0k mapped to an accepted vertical, 8.4k contacts verified-linked (5.4k businesses). 152.6k legacy 'active' contacts are the largest pool; 139k are held at link as legacy-fields-only.
- Binding constraints: Serper SFP provider budget was ~96% consumed (domain discovery fell from ~2,400/day to ~20/day after Oct 19); the 2.5s statement timeout makes the status-overview funnel permanently unavailable on the 2M-row registry table.
- Observed rates: ZeroBounce ~50% valid of answered; Serper website found ~33% per search, identity accepted ~5%; contact-page stage first run 3 of 25 staged an email.
**Why:** the audit answered "what bulk path returns the most validated businesses"; these are the measured inputs.
**How to apply:** re-measure before trusting; the numbers are a dated snapshot, not live state.
