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

For this already-published app, a supported configuration change to `vm` did
not by itself switch the next actual publication: publishing retained Autoscale
and rewrote the workspace target to `cloudrun`.

**Why:** The owner's subsequent publish served the new corrections, but fresh
deployment metadata and the publication's configuration diff both showed that
the hosting change had not taken effect.

**How to apply:** Do not ask for another unchanged Publish click or assume that
the published app's Adjust settings contains a deployment-type selector. The
owner's mobile screenshots show Autoscale sizing controls only. Verify the
existing-deployment switching procedure and obtain consent for any required
unpublishing/downtime before directing the owner to it. Recheck live metadata,
not just the file or a successful build.
