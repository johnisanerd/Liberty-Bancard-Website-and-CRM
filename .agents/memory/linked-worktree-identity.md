---
name: Linked worktree identity after environment restoration
description: Missing worktree Git links can silently redirect branch-scoped commands into the primary repository.
---

Before running branch-scoped commands in a linked worktree, verify its reported
repository top-level, HEAD, and branch match the intended worktree.

**Why:** Restored worktree directories retained source and historical evidence
but lost their `.git` links. Git searched upward and silently treated the primary
repository as the target of `git -C`, even though worktree metadata still existed.

**How to apply:** Check `git -C <worktree> rev-parse --show-toplevel` and its
branch before trusting the directory. Use `git worktree repair` to restore
registered links, then verify again. Preserve dirty historical evidence; do not
delete old worktrees or manually replace their metadata to solve this.
