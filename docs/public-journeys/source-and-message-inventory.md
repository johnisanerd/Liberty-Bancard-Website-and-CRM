# Public source, journey and message inventory

Status as of 2026-10-23. Owner = the single code path that records the occurrence and its local work. "Receipt" = the one
acknowledgement owned by `server/services/inbound-acknowledgement.ts`. Receipts ship **blocked** (capability closed).

| Source / journey | Recording owner | Local outcome | Receipt | Disposition |
|---|---|---|---|---|
| estimate_form, get_started_form (six-step quiz), callback_form, free_analysis, integration_request | inbound request authority (sales_request) | assignment, sales task, SLA | ack owner (`ack.sales_request`) | Retain; receipt wording is factual (no timing, no quote claim) |
| statement_upload (public, token, merchant portal, dashboard) | statement-upload-chain over inbound request | file evidence, deal stage, statement review, rep notification | ack owner; chain step 9 only reports its state; step 7 records a handoff identity (no provider write) | Retain; old confirmation helpers never send |
| support_form | inbound request authority (support_request) | ticket, SLA | ack owner (`ack.support_request`) | Retain |
| equipment_order | inbound request authority (fulfillment_request) | fulfillment order, SLA, internal notification | ack owner (`ack.fulfillment_request`) | Retain |
| testimonial_submit | inbound request authority (content_reputation) | moderation item | none by design | Retain |
| newsletter_signup | inbound request authority (marketing_opt_in) | consent evidence, eligibility readiness | none here (confirmation policy owned by consent authority) | Retain; no deal, no silent promotional enrollment |
| partner application (`/api/partner-apply`) | partners route: partner row (application of record) | contact record, in-app review notification (replay-safe key) | receipt owner (`partner_application_request`, closed until enabled); response reports `emailReceipt: queued` or `not_enabled` | Done: admin-only review notification linked to the request |
| privacy request (`/api/data-requests`) | admin route: `data_delete_requests` | restricted in-app notification, review command unchanged | contactless receipt to the submitted mailbox only (`privacy_request`, closed until enabled); response reports `emailReceipt: queued` or `not_enabled` | Due-date policy remains an owner decision |
| merchant application draft / submit | merchant application service + outbox worker | drafts stay drafts; submitted events go through the outbox | outbox worker (pause/missing prerequisite wait; no dead letter) | Retain; list shows "Draft started … not submitted" |
| live chat | live-chat routes | session, visitor message, internal critical notification | none | Retain; shared public limiter added |
| `/thanks/application` | client page | reads session receipt only | n/a | Truthful: no context, no claim |
| login / account security | existing security authority | n/a | existing policy | Out of scope; not migrated |

## Enabled workflows (17) — configuration evidence only
Run `npx tsx scripts/audit-retained-message-copy.ts` (read-only) for the current findings. On the development copy it reports:

| Workflow | Finding | Proposed action (owner review) |
|---|---|---|
| B. Estimate Request Intake | `[UPLOAD_LINK]`; asks recipient to reply with attachments | Replace with `{APP_URL}/upload-statement`; remove the attachment ask |
| D. No-Show Rescue, E. Proposal Follow-Up | "your analysis is saved" with no recorded analysis | Reword to what the recipient can actually do |
| F. Closed Won Onboarding | invites emailed ID / voided check | Point to the secure document journey once its recipient authorization is proven |
| G. Go-Live Lifecycle, template "Day 7 Review Request" | `[GOOGLE_REVIEW_LINK]` | Remove the review ask until a verified review URL is supplied; do not invent one |

The replacements in `copy-reconciliation.md` have been applied as an owner-approved content change (no workflow,
template or campaign was toggled). F still points to a secure link from the representative; the secure document journey
itself is unchanged. Publishing stored copy never activates a workflow, campaign or release.
