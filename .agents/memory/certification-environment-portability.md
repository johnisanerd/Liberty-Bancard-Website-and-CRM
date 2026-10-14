---
name: Certification environment portability
description: Native timezone changes and Express file serving behave differently in isolated certification worktrees.
---

Run timezone-dependent Node tests in child processes with TZ set at startup, rather than changing TZ after the certification environment scrub.

**Why:** The certification harness replaces process.env with a plain object. Later TZ assignments do not notify Node's native timezone cache; a Samoa skipped-day regression passed directly but failed under CI.

**How to apply:** Keep the provider-denied environment intact; launch pure date tests with explicit startup TZ. Do not weaken the date assertion or change the generic environment scrub.

Serve browser fixture HTML relative to an explicit public root, rather than using an absolute sendFile path containing the entire checkout directory.

**Why:** A checkout under .local produced Express NotFound responses despite a verified existing production index. Absolute paths include dot-directory components that default dotfile protection rejects.

**How to apply:** Retain ordinary dotfile protection. Resolve the public directory as the root and send the index filename relative to it; never expose the checkout with dotfiles: allow.
