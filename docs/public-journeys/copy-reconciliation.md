# Retained copy reconciliation

## State by stage (read this first)

| Stage | State |
|---|---|
| Implemented | Round-1 repairs (F1-F7) are in revision `5d8f4f95`. Round-2 corrections (below) are in the workspace and **not committed or pushed** at the time of writing. |
| Published | Production served `5d8f4f95` when last measured (2026-10-24). Round-2 corrections, including migration `0373`, are **not published**. |
| Production-accepted | **No.** Convergence applied seven replacements on the published build; acceptance of stored wording, ordinary local processing and held receipts needs a signed-in read after the next publish. |

Why the earlier "applied" claim was wrong: the replacements were attached to the seed step, and seeds do not overwrite
rows that already exist, so publishing code alone left the old wording in stored rows.

## Round-2 corrections (workspace)

- Partner and affiliate applications: the occurrence is bound to the exact account created from it (same-transaction
  mailbox pin), recovery resumes unfinished work, and a reused contact keeps the occurrence as a source event.
- Convergence publishes atomically through `publishSystemWording` (no draft row is created or overwritten) and reports a
  `partial` status when some rows were replaced and others were left alone.
- Approval, invite and affiliate welcome are durable rows (`partner_approval_deliveries`, migration `0373`) written in the
  same transaction as the approval. Waits (pause, provider contact not yet known) never consume an attempt; an invite with
  an unknown outcome is `ambiguous` and is only re-sent by an operator, which issues a fresh link. Promotional sequences are
  never used as the welcome. Provider completion stays with the GHL companion work.
- Review ownership: `GET /api/admin/inbound-review-queue` shows the gap; `POST .../reconcile` creates missing review notices and fills
  or replaces an owner only when it is absent or no longer a valid reviewer. Valid assignments are never overwritten and
  no request status changes. The owner and due hours are still an administrator's recorded choice (Data Requests page).
- Final previews: stored templates and workflow email steps share one final view built with the same composer the
  transport uses (one signature block, one logo, one footer). The provider call carries an **HTML body only**; the plain
  text shown is generated reference text, not a transmitted MIME part. Sender and Reply-To show as unknown unless the
  sending path supplies them. A role-mailbox greeting inside an HTML paragraph now reads "Hello,".
  Not done: stored template and workflow bodies are not given a Liberty signature automatically; they keep the signature
  their sending family chose, and the preview reports present/absent. Adding one to every message is a product decision.

## How replacements are applied now

- `convergeReviewedCopy()` in `server/services/reviewed-copy-replacements.ts` is the only applier. It is **not** part of
  the seeds. It runs at startup when the background profile is not `off`, and an admin can run or read it through
  `POST` / `GET /api/message-copy/convergence`.
- Replacements are exact-substring rewrites of stored wording. Template wording is published as a new content version
  through the same versioning path the editor uses, so operator edits made after the reviewed text are preserved
  (a row that no longer contains the old text is left alone and reported).
- Workflow rewrites use the versioned workflow command. Convergence never sets or changes `enabled` / `isActive`, and
  sends nothing. Each run records an audit row (`reviewed_copy_convergence_run`) with per-row outcomes and a status of applied, partial, current, conflict or failed.
- Every token in stored wording is checked against one registry (`server/services/message-token-registry.ts`) and
  rendered by one strict renderer for template, workflow, SMS, packet and review sends. A token the sender cannot supply
  fails the send before any provider call. `agentName`, `referenceId`, `agentEmail` and `agentPhone` are intentionally
  unsupported in workflow and template wording.
- `scripts/audit-retained-message-copy.ts` is read-only and covers workflows, message templates, sequence steps (both
  variants) and campaign steps.

## Test evidence (disposable PostgreSQL, fake transports, final code)

These certifications run only when selected (`--only <file>` on the disposable launcher). They are registered in
`CERTIFICATION_FIXTURE_SUITES` and are **not** part of the default pre-deploy run; a green default pre-deploy does not
mean they ran.

| Suite | Result |
|---|---|
| `test-message-copy-convergence.ts` | 65 checks pass |
| `test-message-template-versions.ts` | 56 checks pass |
| `test-workflow-email-wording.ts`, `test-workflow-sms-wording.ts` | pass |
| `test-inbound-acknowledgement.ts` | 92 checks pass (includes override refusal, final capability recheck, worker status) |
| `test-merchant-outbox-handoff.ts` | MOH-01..10 pass |
| `test-partner-application-resume.ts` | PAR-01..15 pass |
| `test-template-final-preview.ts` | TFP pass (payload builder, one signature/footer, greeting, workflow final view) |
| `test-partner-application-resume.ts`, `test-partner-application-crash-boundaries.ts` | 15 and 20 checks pass |
| `test-partner-approval-delivery.ts` | 26 checks pass (registered in pre-deploy) |
| `test-review-ownership-reconcile.ts` | 14 checks pass (registered in pre-deploy) |

Baseline comparison (not attributed without it): see "Baseline comparisons" at the end of this file.

## Public timing copy and review policy

The partner page no longer promises "start referring merchants within 24 hours", and the privacy page no longer says
requests are processed "within 30 days". No due time is stated publicly because none is recorded. Review owner and due
hours for partner applications and privacy requests exist only if an admin records them with
`PUT /api/admin/inbound-review-policy`; until then notifications say `reviewPolicy: not_configured`. Add a public
timing statement only together with a recorded policy.

Admins edit template wording in GHL Settings -> Message Templates: **Save draft**, **Publish content version**,
**Activate campaign actions** are separate commands, and receipts are turned on separately with **Enable transactional
purpose** (Request receipts card). Publishing never activates anything. Publishing is blocked while wording contains
an unresolved placeholder, dead link, emailed-attachment ask, unsupported timing/proof claim or "record exists" claim.

The upload link is the absolute `https://libertybancard.com/upload-statement` (workflows have no `{APP_URL}` resolver;
other seeded workflow links are absolute in the same way).

| Location | Was | Applied / proposal |
|---|---|---|
| Workflow B, upload step | `[UPLOAD_LINK]` | Button "Upload your statement" to `{APP_URL}/upload-statement`, with the same URL as a text link below it |
| Workflow B, attachment ask | "reply to this email with the statement attached" | Remove; the upload page is the only requested channel |
| Workflow D / E | "your analysis is saved" | "If you would like us to review your statement, you can upload it here." (only when no analysis record exists) |
| Workflow F | asks for emailed ID / voided check | "Your representative will share a secure link for documents." Do not ask for email attachments |
| Workflow G, template Day 7 | `[GOOGLE_REVIEW_LINK]` | Remove the review request until a verified URL exists |
| Partner page | "within 24 hours" / "1 business day" promises | Removed in code; not yet published |
| Privacy page | "within 30 days" promise | Removed in code; not yet published; restore only with a recorded policy deadline |
| Inbound receipts | none stored | `ack.sales_request`, `ack.support_request`, `ack.fulfillment_request`: factual receipt with reference, no timing, no CTA, one logo from the signature owner |

Receipt subject: `We received your <request type> (ref XXXXXXXX)`. Sender and Reply-To come from the `support` sender policy.

## Baseline comparisons

Measured on the audit baseline revision `4130c291` (separate worktree) and on the workspace with the round-2 changes:

| Check | Baseline `4130c291` | Workspace |
|---|---|---|
| Full `tsc --noEmit` | 5 errors: `server/db.ts` (getTransactionConfigSQL), `server/routes/admin.ts` (2), `server/routes/live-chat.ts` (2) | The same 5 errors, none in files changed here. The type check is not clean; these are existing and unresolved. |
| `npm run build` | not run | passes |
| `test-intake-review-pages.ts` | fails: "Full-page source namespace probe must execute its index" | fails with the same assertion. Existing failure, not caused or fixed by this work. |

`scripts/test-merchant-application-security.ts` was compared separately earlier (stale assertion, same result with changes stashed) and is not part of this table.
