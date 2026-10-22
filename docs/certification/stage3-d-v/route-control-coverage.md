# Stage 3 D-V route and control coverage (dev serving build, 2026-10-22)

Signed-in admin crawl of 45 current dashboard routes at 1280, 768 and 390 px (desktop layout forced). Collected by `tools/resp.mjs`; raw rows in `responsive-a11y-crawl.json`. Checks per width: exactly one h1, one main landmark, no horizontal page overflow, no error boundary text, no duplicate ids, no visible image without alt, visible controls without an accessible name.

| Route | h1 (1280/768/390) | page overflow px | unnamed controls | duplicate ids | error text |
|---|---|---|---|---|---|
| /dashboard/activation | 1/1/1 | 0/0/0 | 0/0/0 | no | no |
| /dashboard/admin-hub | 1/1/1 | 0/0/0 | 0/0/0 | no | no |
| /dashboard/ghl-integration | 1/1/1 | 0/0/0 | 0/0/0 | no | no |
| /dashboard/queue-holds | 1/1/1 | 0/0/0 | 0/0/0 | no | no |
| /dashboard/settings/arbitration | 1/1/1 | 0/0/0 | 0/0/0 | no | no |
| /dashboard/settings/integrations | 1/1/1 | 0/0/0 | 0/0/0 | no | no |
| /dashboard/system-health | 1/1/1 | 0/0/0 | 0/0/0 | no | no |
| /dashboard/outbound-center | 1/1/1 | 0/0/0 | 0/0/0 | no | no |
| /dashboard/comms-hub | 1/1/1 | 0/0/0 | 0/0/0 | no | no |
| /dashboard/boarding | 1/1/1 | 0/0/0 | 0/0/0 | no | no |
| /dashboard/co-branded-proposals | 1/1/1 | 0/0/0 | 0/0/0 | no | no |
| /dashboard/document-vault | 1/1/1 | 0/0/0 | 0/0/0 | no | no |
| /dashboard/merchant-applications | 1/1/1 | 0/0/0 | 0/0/0 | no | no |
| /dashboard/merchant-risk | 1/1/1 | 0/0/0 | 0/0/0 | no | no |
| /dashboard/merchant-success | 1/1/1 | 0/0/0 | 0/0/0 | no | no |
| /dashboard/onboarding | 1/1/1 | 0/0/0 | 0/0/0 | no | no |
| /dashboard/onboarding-kickoff | 1/1/1 | -15/-15/-15 | 6/6/6 | no | no |
| /dashboard/partner-orgs | 1/1/1 | 0/0/0 | 0/0/0 | no | no |
| /dashboard/partner-portal | 1/1/1 | 0/0/0 | 0/0/0 | no | no |
| /dashboard/partner-referral-pipeline | 1/1/1 | 0/0/0 | 0/0/0 | no | no |
| /dashboard/portfolio | 1/1/1 | 0/0/0 | 0/0/0 | no | no |
| /dashboard/referral-program | 1/1/1 | 0/0/0 | 0/0/0 | no | no |
| /dashboard/statement-review | 1/1/1 | 0/0/0 | 0/0/0 | no | no |
| /dashboard/support-hub | 1/1/1 | 0/0/0 | 0/0/0 | no | no |
| /dashboard/underwriting | 1/1/1 | 0/0/0 | 0/0/0 | no | no |
| /dashboard/pipeline | 1/1/1 | 0/0/0 | 0/0/0 | no | no |
| /dashboard/canonical-enrichment | 1/1/1 | 0/0/0 | 0/0/0 | no | no |
| /dashboard/lead-ops | 1/1/1 | 0/0/0 | 0/0/0 | no | no |
| /dashboard/outreach-queue | 1/1/1 | 0/0/0 | 0/0/0 | no | no |
| /dashboard/prospects/import | 1/1/1 | 0/0/0 | 0/0/0 | no | no |
| /dashboard/contacts | 1/1/1 | 0/0/0 | 0/0/0 | no | no |
| /dashboard/contacts-leads | 1/1/1 | 0/0/0 | 0/0/0 | no | no |
| /dashboard/my-leads | 1/1/1 | 0/0/0 | 0/0/0 | no | no |
| /dashboard/leaderboard | 1/1/1 | 0/0/0 | 0/0/0 | no | no |
| /dashboard/my-earnings | 1/1/1 | 0/0/0 | 0/0/0 | no | no |
| /dashboard/reporting | 1/1/1 | 0/0/0 | 0/0/0 | no | no |
| /dashboard/content-hub | 1/1/1 | 0/0/0 | 0/0/0 | no | no |
| /dashboard/knowledge-admin | 1/1/1 | 0/0/0 | 0/0/0 | no | no |
| /dashboard/knowledge-base | 1/1/1 | 0/0/0 | 0/0/0 | no | no |
| /dashboard/playbooks | 1/1/1 | 0/0/0 | 0/0/0 | no | no |
| /dashboard/training | 1/1/1 | 0/0/0 | 0/0/0 | no | no |
| /dashboard | 1/1/1 | 0/0/0 | 0/0/0 | no | no |
| /dashboard/my-day | 1/1/1 | 0/0/0 | 0/0/0 | no | no |
| /dashboard/nba | 1/1/1 | 0/0/0 | 0/0/0 | no | no |
| /dashboard/tasks-appointments | 1/1/1 | 0/0/0 | 0/0/0 | no | no |

Routes: 45. Routes failing h1/overflow/error/duplicate-id/alt checks: 0.

Unnamed-control note: /dashboard/onboarding-kickoff reports 6 at all widths. Re-checked excluding elements inside or marked aria-hidden (Radix hidden form mirrors for selects and checkboxes, `tabindex=-1`): 0 remain (tools/un.mjs). Findings fixed in this pass, each found by this crawl: People contact links for records with no person name (35 on the dev dataset), People Show Archived switch, three Pipeline toggles, Partner Referral Pipeline email icon link, 15 Knowledge Admin archive icon buttons.

Not covered by this crawl: pages reachable only by selecting a record or opening a dialog, contrast beyond the calculations recorded in ledger Section 40, screen-reader behavior, and axe-core (not installed). Target size: one inline text link (2FA banner link, 70x20 px) is under 24 px tall on every route; it is an inline link in a sentence.
