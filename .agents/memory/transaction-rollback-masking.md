---
name: Transaction rollback masking
description: Idle session termination can be hidden by a later failed rollback; preserve both without relaxing failure boundaries.
---

Capture the original callback failure before the transaction library attempts
automatic rollback. If rollback fails too, retain both failures and keep the
result fatal; an earlier confirmed abort must not conceal uncertain cleanup.

**Why:** Production native upload statements reported SQLSTATE 25P03, but the
outer transaction error exposed only a failed rollback after the connection
terminated. Looking solely at the outer error discarded the useful diagnosis.

**How to apply:** Do not reinterpret connection or confirmation loss as a
permanent row failure or a safe retry. Keep token/owner/native guards on every
attempt. An unexpired lease may also outlive a failed processor: explicit
claim-fenced resumption, not the lease alone, establishes renewed processing.
