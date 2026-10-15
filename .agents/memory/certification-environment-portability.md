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

Separate fresh Chromium process startup from application performance budgets, and await actual nested-modal opening focus before testing one-key Escape dismissal.

**Why:** Hosted CI sometimes needed more than ten seconds to create a debugging port. A separate CI keyboard case observed the dialog title before opening focus had settled; Escape did not reach the new modal.

**How to apply:** Use a bounded startup allowance without relaxing useful-list/local-response limits. Require modal-owned focus and settled animation frames, then keep the single Escape and exact caller-focus assertions.

Observe overlay dismissal, pointer unlocking and connected caller-focus restoration separately.

**Why:** A protected keyboard case observed the Sheet disappear and body pointer events unlock while focus was still on the body. Those first two observations did not establish the third; the focus case remained failed.

**How to apply:** Preserve the actual connected-focus assertion after native dismissal. A bounded wait may observe the application's restoration, but do not force focus from the test or certify restoration merely because the overlay disappeared.
