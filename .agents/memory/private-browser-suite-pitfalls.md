---
name: Private browser suite pitfalls
description: Running mounted-browser suites on the disposable launcher (candidate identity, narrow viewports)
---
Browser suites verify candidate identity against `dist/`, and the identity covers `scripts/`: rebuild with `npm run build` after ANY script or client edit, then run with `NODE_ENV=production npx tsx scripts/run-sfp2060-predeploy-disposable.ts --only <suite>`.
**Why:** a stale build fails identity verification before the suite starts.
Narrow viewports (<768px) redirect `/dashboard` to the mobile shell; set `localStorage.prefer_desktop="true"` (the app's own Switch-to-desktop preference) before testing desktop layouts at 320/390.
Wait on specific test IDs, not on generic text, when a failure is injected with `failRead`; counting right after a loose text match flakes.
