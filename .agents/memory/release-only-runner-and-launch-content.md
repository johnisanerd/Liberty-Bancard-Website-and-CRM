---
name: Release-only runner and SFP launch content
description: How admitted canonical releases send while legacy producers stay off, and pitfalls building the fake-SMTP disposable certification.
---
With the legacy outreach flag off, the sequence handler runs only admitted released enrollments (release-only mode), never campaign queues or auto-conversion. SFP launch steps require SMTP: if unavailable they defer with an audit row, never falling back to GHL. Empty sequences defer (1h) instead of completing.

**Why:** a released membership on an empty or unsendable sequence must not be recorded as completed outreach, and only SMTP carries the signed List-Unsubscribe headers.

**How to apply:** a disposable end-to-end cert for the real worker needs all of: an `unpaused` outbound_pause_control row (disposable DB has none, so it fails closed), emailChannelPaused/coldEmailChannelPaused false, a mailing-address setting, SMTP env set AFTER the provider deny boundary, a contact with email_status valid plus a zerobounce observation linked to a completed provider_operations row (otherwise contactability reports mismatched_email_token), and a content-ready sequence for release selection.

Stale package pins on prepared intents only affect validation selection; release/inventory do not check pins, and the preparation worker re-prepares on cursor passes.

test-sequence-compliance fails identically on baseline (mismatched_email_token fixtures, daily-cap audit); not caused by this work.
