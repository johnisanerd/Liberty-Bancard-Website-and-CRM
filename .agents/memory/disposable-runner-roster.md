---
name: Disposable runner roster
description: How to run an unregistered scripts/certification suite on a disposable DB
---
The isolated launcher (`scripts/run-sfp2060-predeploy-disposable.ts --only <path>`) rejects any script not in `MANDATORY_SUITES` or `CERTIFICATION_FIXTURE_SUITES` (pre-deploy.ts). Entries in the fixture list run only on explicit selection.

**Why:** running a cert directly fails the disposable-infrastructure guard.
**How to apply:** add the suite to `CERTIFICATION_FIXTURE_SUITES` (requiresDisposableTestDatabase), run one per call under 290s or via a background shell; a workspace restart kills background tasks and /tmp logs. serper-lookup-memory and intake-review-pages failed in the C3 session on code C3 did not touch.
