# Retained copy reconciliation (proposals only)

Nothing here has been applied. Each proposal needs owner approval and then the supported content publication path.

| Location | Current | Proposal |
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
