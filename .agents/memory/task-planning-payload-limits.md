---
name: Large planning payloads
description: Observed task-plan and notebook limits when preserving large portable audit packages.
---

Observed tool limits are 262,144 UTF-8 bytes per task plan and 32 MiB of retained CodeExecution notebook state. Treat newer explicit tool errors as authoritative if these limits change.

**Why:** Large historical task packages plus a complete audit appendix exceeded the task limit. Keeping full task descriptions and several derived copies in notebook variables then exceeded its retained-memory limit, resetting all variables.

**How to apply:** Measure bytes before updating a task, not character count. Preserve the original scope and immutable evidence; compact the new appendix or abbreviate regenerable Git blob identities rather than removing historical inputs. Keep the full audit separately when a nearly full task can accept only a concise annotation.

Filter large task callbacks within a local function and retain only the summary needed for later calls. Do not print or persist complete task payloads repeatedly. After a parallel update fails, inspect which updates actually persisted before retrying; a failed block does not undo successful task updates.

Plan-mode shell protection can reject ostensibly read-only Git inspection with a `.git/index.lock` error, including calls with `GIT_OPTIONAL_LOCKS=0`.

**Why:** Planning-document checks succeeded, but subsequent Git inspection in the same shell call was rejected; disabling optional Git locks did not avoid the protection.

**How to apply:** Separate document-content validation from Git inspection so a rejected Git operation does not obscure valid results. Use the saved task body and a hash-verified existing snapshot to prove preservation of ignored local plan files; never weaken Plan-mode protection or modify Git configuration to proceed.
