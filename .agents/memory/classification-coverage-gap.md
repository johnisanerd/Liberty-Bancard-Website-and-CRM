---
name: Classification coverage gap and evidence ceiling
description: Why most canonical businesses were never classified, why review_required is mostly missing evidence, and what gates validation of staged candidates.
---

- The free classification continuation cursor only moves forward; canonical businesses below the watermark that never got evidence or a routed item were never visited (about 68.7k in production, mostly registry-sourced names with no website or zip). The pass now rewinds when such a gap exists, and the window query skips businesses that already have current-version evidence.
- review_required is overwhelmingly missing evidence, not strict rules: ~97% of review_required businesses have no website. OpenAI already escalated many name-only businesses and returned insufficient evidence. More escalation volume will not fix it; website/category evidence must be obtained first.
- Serper domain discovery is restricted to businesses already in a target vertical, so unlabeled businesses without a website cannot get a website that way (chicken-and-egg). Any new vertical-evidence stage needs its own Serper budget decision (provider ceiling was ~14k units left).
- Staged first-party/crawler email candidates are not contacts: validation_intents need a contact, and contacts begin unlinked and link through the commercial link authority (admin reviewer) or the linker. Validating staged candidates without a cohort needs a materialize-to-contact design, not just removing the cohort check. Only ~23% of staged candidates' businesses are mapped to a target vertical, so most credits would go to non-targets.
**Why:** prevents repeating the "83% unlabeled / raise the cohort cap" misdiagnosis.
**How to apply:** check evidence/website coverage before scaling classifier or validation throughput.
