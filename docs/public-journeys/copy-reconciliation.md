# Retained copy reconciliation

## State by stage (read this first)

| Stage | State |
|---|---|
| Implemented | Correction code and tests are in the workspace and **not committed or pushed** at the time of writing. |
| Published | Revision `2822c7d2` (the earlier build) is what was served when the post-publish audit ran. This correction has **not** been published. |
| Production-accepted | **No.** Stored wording in production has not converged, and no automatic local work or held receipt has been observed on the corrected build. |

Why the earlier "applied" claim was wrong: the replacements were attached to the seed step, and seeds do not overwrite
rows that already exist, so publishing code alone left the old wording in stored rows. Production wording stayed old.

## How replacements are applied now

- `convergeReviewedCopy()` in `server/services/reviewed-copy-replacements.ts` is the only applier. It is **not** part of
  the seeds. It runs at startup when the background profile is not `off`, and an admin can run or read it through
  `POST` / `GET /api/message-copy/convergence`.
- Replacements are exact-substring rewrites of stored wording. Template wording is published as a new content version
  through the same versioning path the editor uses, so operator edits made after the reviewed text are preserved
  (a row that no longer contains the old text is left alone and reported).
- Workflow rewrites use the versioned workflow command. Convergence never sets or changes `enabled` / `isActive`, and
  sends nothing. Each run records an audit row (`reviewed_copy_replacements_applied`) with per-row outcomes.
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
| `test-message-copy-convergence.ts` | 57 checks pass |
| `test-message-template-versions.ts` | 56 checks pass |
| `test-workflow-email-wording.ts`, `test-workflow-sms-wording.ts` | pass |
| `test-inbound-acknowledgement.ts` | 92 checks pass (includes override refusal, final capability recheck, worker status) |
| `test-merchant-outbox-handoff.ts` | MOH-01..10 pass |
| `test-partner-application-resume.ts` | PAR-01..15 pass |
| `test-template-final-preview.ts` | TFP-01..07 pass |

Known failures not caused by this work: `test-intake-review-pages.ts` (query-plan assertion on large row volume) and one
stale assertion in `scripts/test-merchant-application-security.ts` (fails identically with these changes stashed).

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
