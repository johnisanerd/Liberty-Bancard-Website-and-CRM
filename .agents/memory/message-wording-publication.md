---
name: Message wording publication
description: Wording, activation and receipt delivery are separate, reviewed commands
---
Saving a draft, publishing a content version, activating campaign use, and enabling transactional receipts are four separate commands; publishing never activates anything, and wording that fails the shared copy checks cannot be published or activated.

**Why:** a direct edit could put unreviewed copy (placeholders, emailed-attachment asks, unsupported claims) live and sendable.
**How to apply:** route any new wording edit through the versioned draft/publish path; rewrite enabled workflows' stored copy only by exact-substring replacement that never touches their enabled state, and keep seed data in step with it.

Inline workflow email and SMS steps (send_ghl_email subject/body, send_ghl_sms body) follow the same rule: preview is side-effect free, publish is lint-gated and goes through the versioned workflow save command passing only `actions` (never `enabled`). Steps with a templateId are edited on the template, not inline.
