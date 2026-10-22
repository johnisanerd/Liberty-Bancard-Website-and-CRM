---
name: D-V review repair patterns
description: Reusable test/design patterns from the Stage 3 D-V independent-review repairs.
---
- Cohort destinations: Today counts and the opened list must share one predicate and a URL-held selector read each render (not one-time useState), so reload/Back/Forward restore it.
- Real-component deferred-response tests: wrap `window.fetch` in the page (hold/fail modes keyed on URL) and drive navigation with pushState+popstate; no server fixture change needed.
- Streaming CSV exports: read the first page before sending headers; after streaming starts, destroy the connection on failure rather than ending a short file.
- Browser suites fail "rebuild required" after any scripts/ edit (identity covers scripts/); rebuild after adding a suite.
- Receipt fencing for apply flows: owner token + generation, per-action re-pin of admin authority, same per-mailbox advisory lock as `writeContact`.
**Why:** each was a review finding that needed more than one attempt to get right. **How to apply:** reuse before inventing a new mechanism.
