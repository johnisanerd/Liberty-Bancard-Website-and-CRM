---
name: Stale dist and missing-import gaps
description: Browser suites read the built dist; scripted bulk edits can leave a page without its import and only fail at render time.
---
Rebuild before any private-browser suite; a stale or pre-fix `dist/public` produces false failures (and hides real ones).

**Why:** a "fails on baseline" claim about the C2 header test was wrong because dist was stale; a bulk page migration left Arbitration Log without its CrmPage import, found only by loading it in a browser (the error boundary then showed its single h1).

**How to apply:** after scripted multi-file edits run the D-R2 contract suite (it checks every shared presentation tag in use is imported) and load each changed screen; measure heading ownership with a MutationObserver/rAF h1 monitor, not single snapshots. Never run full tsc; the build is the compile check.
