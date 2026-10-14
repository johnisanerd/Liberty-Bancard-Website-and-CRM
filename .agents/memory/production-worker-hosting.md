---
name: Production worker hosting
description: Owner-approved always-on hosting for this app's existing background workers.
---

Use Reserved VM for the next publication of the existing app and its continuous
workers, rather than returning it to Autoscale without the owner's approval.

**Why:** The owner selected Reserved VM after being told it uses ongoing compute
and that request-driven Autoscale can scale to zero. Continuous worker execution
is part of the original intake and business-assignment acceptance.

**How to apply:** Preserve the existing build/run commands and provider/outbound
controls. A configured target is not proof of the live hosting type: verify
deployment metadata after publication. Do not infer that always-on hosting alone
solves database/runtime delays or establishes production acceptance.
