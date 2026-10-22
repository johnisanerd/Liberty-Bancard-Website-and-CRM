---
name: Domain/location assignment automation
description: Closed-by-default worker for the independent domain+company+location tier
---
Worker reuses the manual policy and audited writer; an admin PUT enables it and is recorded as reviewer. Conflicts are preserved, never reassigned.
**Why:** domain alone never links; only the owner-approved independent tier is automated, and yield is small (~3% become new recipients).
**How to apply:** after publish, enabling is an admin PUT; do not widen the tier without owner approval.
