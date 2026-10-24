---
name: Partner approval delivery, occurrence binding, review reconcile
description: Durable design rules for partner/affiliate account binding, approval/welcome delivery rows, review ownership reconcile, and final-email preview truthfulness
---
- Occurrence-to-account binding: pin `submitted_email` on the inbound request in the same transaction that creates the account; recovery must never adopt an unrelated same-mailbox account; unbound occurrences fail after a short grace.
  **Why:** a crash between account creation and binding otherwise let recovery attach the wrong person.
- `createNotification` is not idempotent on commandKey: look up by key first.
- Approval/welcome intent is a row (partner_approval_deliveries) written in the same tx as the status change. Waits (pause, provider contact unknown) never consume attempts or mark sent. Invite with unknown outcome = ambiguous, never auto-resent; operator resend issues a fresh link. Welcome (no secret) may retry.
  **Why:** auth_actions purpose has a DB CHECK and inbound_request_effects is manifest-governed, so a small new table was cheaper than extending them.
- Review reconcile fills/replaces an owner only when absent or no longer a valid reviewer; never overwrites a valid assignment, never changes request status; owner/due come only from the admin-recorded policy.
- Convergence publishes via publishSystemWording (no draft row) so an operator draft created mid-run is never clobbered; `partial` status exists.
- Final previews: GHL transport sends HTML only (buildGhlEmailPayload is the single payload builder). Plain text is reference text. Sender/Reply-To are "unknown" unless the sending path supplies them. Signature owner marks its block (data-liberty-signature) so one-signature is countable; nothing auto-adds a signature (product decision left open).
- Baseline facts: full tsc has 5 pre-existing errors (db.ts, admin.ts x2, live-chat.ts x2); test-intake-review-pages fails identically on 4130c291.
