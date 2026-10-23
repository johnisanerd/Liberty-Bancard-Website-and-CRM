---
name: Inbound acknowledgement owner design
description: Authorization principle for receipt emails sent for inbound requests while global outbound stays paused
---
A receipt is authorized per message from durable state, never by a caller flag or a general unpause. The recipient is the mailbox captured with the request occurrence (immutable), not the current CRM value; a changed address means no send.
**Why:** the request required receipts without unpausing, replaying history, or disclosing request details to an address the submitter did not provide.
**How to apply:** default-closed capability per request type; eligibility only moves forward (never backdated); block reasons that can never clear must be excluded from worker selection or they starve newer work; transient waits rotate by least-recently-touched; uncertain outcomes are never resent.
