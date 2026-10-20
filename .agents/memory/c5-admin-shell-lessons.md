---
name: Administration/Resources shell lessons
description: Durable constraints for the admin diagnostics, Administration areas, Resources nav and employee sidebar cutover.
---
- Express 5 router keeps no mount path on `use()` layers; record mounts by instrumenting router creation before registration, and label anything registered earlier "unknown" (never public).
- The C1 contract generator derives selectors/children by parsing page files; do not wrap route components in App.tsx, put shared navs inside pages.
- GHL workflow IDs are two classes: sequence-cadence IDs are reference-only, but supported handoff-workflow enrollments read their saved ID and skip when missing. Never declare all IDs inert in copy or diagnostics.
- A sidebar destination counts as activated only with route + role-guard agreement and browser navigation evidence; a fixture that answers APIs with 501 proves shell/role routing, not data-bearing panels. Say so in receipts.
- A matched performance baseline is cheap: `git worktree add --detach` the pre-change commit, symlink node_modules, `npx vite build`, copy `dist/public` into a gitignored artifacts dir, and serve both client roots from one fixture.
- Naive a11y probes mislabel hidden (closed `<details>`) controls and `<label for>` switches; use `textContent`, `el.labels` and visibility.
- Browser suites verify build identity over `scripts/`: rebuild after any script edit before running.
- Hub pages own the page `h1`; embedded `PageHeader`s inherit `h2` via `PageHeadingLevel`. Raw `<h1>` inside a hub child duplicates the heading; walk suites catch this per route, not per component.
- Soft-collecting `check()` failures in a walk suite reports every defect in one 5-minute run; fail-fast hides dozens of repeats. Background runs need `run_in_background`, not `nohup &`, or they die with the shell.
- Query functions that `.then(r=>r.json())` without `r.ok` turn 5xx into data and crash renderers; check `ok` first.

**Why:** reviewers rejected claims that outran evidence (inert-ID copy, source-only cutover).
**How to apply:** before editing diagnostics copy, sidebar targets or acceptance receipts.
