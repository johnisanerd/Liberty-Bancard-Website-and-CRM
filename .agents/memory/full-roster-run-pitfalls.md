---
name: Full pre-deploy roster run pitfalls
description: How to run and interpret the whole disposable pre-deploy roster without false failures
---
Running the launcher with no `--only` takes about 1 hour for 197 entries, and 8 CERTIFICATION_FIXTURE_SUITES are reachable only with `--only`.

**Why:** the whole run rewrites tracked evidence under docs/certification, so later diff-isolation checks (e.g. the SFP disposable certification) fail on a dirty tree; auth-actions needs its explicit opt-in. Roughly 34 roster entries failed identically on the pre-C3 commit, so a red full run is mostly baseline noise.

**How to apply:** after a full run `git checkout -- docs` and rerun failures singly; compare against a `git worktree` of the earlier commit with node_modules symlinked, and rerun failures singly there. Run long loops as the tracked background task itself (nohup/& inside it gets killed).
