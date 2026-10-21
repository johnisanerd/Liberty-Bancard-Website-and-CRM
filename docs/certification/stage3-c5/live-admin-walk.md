# Live admin walk (Kernel cloud browser, 2026-10-20)

Scope: one signed-in admin session on `dev.libertybancard.com`, navigation only (no clicks that change data). The browser session ended by inactivity before the last 33 routes, so the walk is partial; those routes are listed under "Not walked".

## Walked, loaded without an error screen, console error or failed API call

The 11 sidebar targets, all Lead Operations tabs (14), all Campaigns tabs (8), Reports overview/growth/win-loss, all 11 Administration children, Knowledge Base, and about 95 other `/dashboard/*` routes and legacy redirects (every route up to `pipeline`, plus `playbooks` to `review-complete`). Each recorded final URL, load time, text size, error text and failed `/api` calls.

## Findings

| # | Page | Observation | Status |
| --- | --- | --- | --- |
| 1 | GHL Integration Hub → Settings (`/dashboard/ghl-integration?tab=settings`) | The Recent GHL Activity card rendered 90,293 table rows (about 724,000 DOM nodes, 3.46 million characters) because `/api/ghl/activity` returned the whole log. The page was unresponsive for about 23 seconds (reproduced twice) and the tab later crashed. This is the stall reported earlier; it was not the incoming-sync run. | Fixed in code (activity read capped at 100, max 500, Settings page only); live app still has the old behavior until published |
| 2 | Support → Review Queue (`/dashboard/support-hub?tab=review-queue`) | The page renders and then the main thread stays busy; evaluation timed out for 25+ seconds and the browser tab crashed once. Production holds 30,485 pending `dead_letter_job` rows plus 110 real items, and `GET /api/review-queue` returns all of them; the list shows them without paging and labels them "Quiz". | Fixed in code: the review list and its counts exclude dead-letter history, which now has its own paged card; an admin-only archive route moves finished pending rows to `archived`. Archived rows stay in the database but are deliberately not shown by the history route, counts or item reads (item reads return 404); there is no in-app archive history view. Archiving acknowledges obsolete failure alerts; it does not recover or close the original import-row exceptions. The archive and its audit row commit together. The archive has not been run in production |
| 3 | `/dashboard/partner-portal`, `/dashboard/partner-referral-pipeline` | `GET /api/partners/referral-pipeline` returns 500 | Not investigated |
| 4 | `/dashboard/outreach-queue`, `/dashboard/lead-ops?tab=pipeline`, `?tab=sfp`, `/dashboard/lead-gen` | Network not idle after 8 s; outreach-queue and Inbound Operations kept 60 and 86 loading placeholders | Not investigated |
| 5 | `/dashboard/merchant-portal` as admin | 404 `GET /api/merchant-profile` (admin has no merchant profile) | Probably expected |
| 6 | `/dashboard/partner` | 401 `GET /api/partner/session` (no partner session) | Expected |
| 7 | Every page | CSP blocks `https://i.replit.com/script.js` (workspace banner script) | Dev-environment only |
| 8 | Dashboard | Banner "Your admin account does not have two-factor authentication enabled" | Account setting |

## Not walked

`review-queue` (hangs the tab), `review-requests`, `rfis`, `round-robin`, `sdr`, `sdr-hub`, `security`, `seo-health`, `sequence-report`, `sequences`, `settings/arbitration`, `settings/integrations`, `setup-wizard`, `sms-inbox`, `social`, `social-composer`, `stage-rules`, `statement-review`, `support-hub`, `system-audit`, `system-health`, `system-readiness`, `tasks`, `tasks-appointments`, `terminal-roi`, `testimonial-submissions`, `tickets`, `training`, `underwriting`, `user-management`, `virtual-terminal`, `widget-generator`, `win-loss`, `workflows`. Reports sub-tabs beyond the three visible ones, per-record detail pages, and agent/manager roles were not walked live.
