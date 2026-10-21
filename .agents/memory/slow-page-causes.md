---
name: Slow dashboard page causes
description: Why Outreach Queue, SFP status and Lead Ops health were slow, and what is deliberately cached or pre-filtered
---
- Outreach Queue: the projection evaluates up to 250-500 candidates at ~25 queries each. Unowned contacts always carry OWNER_REQUIRED and can never qualify, so they are excluded in SQL (the "unassigned" filter still lists them). The assignee list is one distinct read, not a projection run.
- Parallel evaluation barely helps (DB-bound); pre-filtering candidates is what removed the wait (22s to 2s on dev).
- SFP status-overview: only the table-scan counts are snapshotted for 60s; pause state, provider controls, spend and Serper state stay live. Lead Ops health serves its expired snapshot while refreshing in the background.
**Why:** prod timings were 27s (assignees), 9s (status-overview every load), 15s cold (health).
**How to apply:** do not cache safety-state fields; any new heavy count belongs in the snapshot, not the live part. Still slow and unfixed: /api/lead-ops/entities (~3.7s, full-table count plus CASE sort; needs an expression index migration) and cold /api/sunbiz/stats full scan.
