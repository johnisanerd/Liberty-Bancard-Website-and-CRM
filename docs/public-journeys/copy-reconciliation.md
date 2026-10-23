# Retained copy reconciliation

Status: the workflow and template replacements below are **applied** (owner-approved with the editor task). They are
exact-substring rewrites of stored wording through `server/services/reviewed-copy-replacements.ts`, run from the seed
step at startup, idempotent, and recorded in `audit_logs` (`reviewed_copy_replacements_applied`). Workflow rewrites use
the versioned workflow command and never pass `enabled`; no workflow, template or campaign was toggled. Template
wording is published as a new content version through the same path admins use in GHL Settings.

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
| Partner page | "1 business day" promise | Removed in code (implemented) |
| Privacy page | "within 30 days" promise | Removed in code; restore only with a recorded policy deadline |
| Inbound receipts | none stored | `ack.sales_request`, `ack.support_request`, `ack.fulfillment_request`: factual receipt with reference, no timing, no CTA, one logo from the signature owner |

Receipt subject: `We received your <request type> (ref XXXXXXXX)`. Sender and Reply-To come from the `support` sender policy.
