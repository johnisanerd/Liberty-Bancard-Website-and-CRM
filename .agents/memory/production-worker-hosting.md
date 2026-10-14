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
the Autoscale resource editor contains a deployment-type selector. The owner's
full mobile screenshots locate **Change deployment type** under **Manage your
app**, below **Database settings**, in expanded **Adjust settings**. Prefer that
guided switch flow over an unrelated Pause or standalone Unpublish action.
Obtain consent for required downtime and keep **Copy your development database
to production database** unchecked: it overwrites production data. Recheck live
metadata and connected domains after publishing, not just the file or build.

Unpublishing to switch hosting removes the published app's custom-domain
connections; the replacement publication can also use a different generated
Replit address.

**Why:** After the approved switch, live metadata confirmed Reserved VM but no
additional URLs, while both previously connected Liberty custom domains returned
404. Official documentation confirms custom domains must be re-linked after
unpublishing.

**How to apply:** Include custom-domain reconnection in a hosting-switch
procedure. Use **Add a domain** for each previous custom hostname, follow the new
publication's exact DNS instructions, and verify HTTPS afterward. Do not assume
old DNS records suffice or unpublish again to fix the domain attachments.
