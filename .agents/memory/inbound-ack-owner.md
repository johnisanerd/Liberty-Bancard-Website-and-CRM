---
name: Inbound acknowledgement owner design
description: How receipt emails for inbound requests are authorized while global outbound stays paused
---
Receipts are owned by one service; delivery capability is default-closed, per request type, and never an unpause.
**Why:** the task required receipts without general unpause, historical replay, or a second sender.
**How to apply:** the SMTP boundary grants a per-message lease only after re-deriving recipient/content/purpose/claim from durable rows; requests before the owner-start pin or the capability window are never emailed; uncertain is never resent; a pause is a wait that consumes no attempt. The pre-deploy static scan needs a literal `=== true` / `await authorize(` in any outbound file. Disposable DBs have no pause control row, so certs must insert a paused row or the authority reads safe_default.
