---
name: Message copy convergence and token contract
description: Why reviewed wording must be applied by convergence, not seeds, and the single token registry/renderer.
---
Reviewed wording replacements are applied only by `convergeReviewedCopy()` (startup when profile != off, plus admin GET/POST `/api/message-copy/convergence`). Seeds never overwrite existing rows.
**Why:** a publish of code alone left old stored wording in production; docs had wrongly claimed seed-step application.
**How to apply:** one token registry/strict renderer serves template, workflow, SMS, packet, review sends; unsupported tokens fail before any provider call. Convergence never toggles enabled/isActive and preserves operator edits (row without old text is skipped and reported).
