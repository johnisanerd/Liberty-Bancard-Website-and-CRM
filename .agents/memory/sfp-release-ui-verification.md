---
name: SFP release UI verification recipe
description: How the signed-in release-panel UI is verified against disposable data, and a backlog SQL defect it exposed.
---
Build the client to `generated-artifacts/ui-verify-public` (run `npx vite build --outDir generated-artifacts/ui-verify-public` — vite's root is `client/`, so the output lands in `client/generated-artifacts/`; move it to the repo-root path), then run cert `sfp-launch-release-ui` (stage3BHttpFixture real logins + private Chromium helper). The Launch inventory and release panel only render inside the Backlog view, which needs `/api/canonical-enrichment/backlog` to succeed.

**Why:** the backlog read had an extra `)` after the bound-verticals CTE and returned 503 for every environment, hiding the whole inventory/release UI; only a real browser pass against the real route showed it.

**How to apply:** if the Backlog view shows "could not be counted", run `readCanonicalEnrichmentBacklog({fresh:true})` in a disposable DB and read `err.cause` for the Postgres position. Panel text is CSS-uppercased in `innerText`; match case-insensitively. A realistic uncertain-delivery hold needs a real `outbound_send_log` attempt plus `heldIdempotencyKey`, otherwise resolve correctly refuses.
