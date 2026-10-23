---
name: Actor-change browser test trigger
description: How to change the signed-in actor under an open Contact page in a real-browser suite
---
Only /api/auth/user revalidation moves the SPA's protected actor; Login redirects signed-in users and logout hard-navigates. Cookie swap (in-page POST login) or a DB change to users.account_version/permissions, then Date.now skew + synthetic offline/online events, triggers the app's own reconnect refetch of the 5-minute-stale auth query.

**Why:** a late response only matters inside one document; the hold must strip the fetch abort signal or the browser rejects it and nothing late arrives.
**How to apply:** reuse the pattern in the D-V contact actor browser suite; hold reads by generation (old actor gen 0, new actor gen 1) so the late old response is released before the fresh one.
