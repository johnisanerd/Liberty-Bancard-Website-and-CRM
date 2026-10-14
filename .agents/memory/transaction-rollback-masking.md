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

Safe diagnostic readers must also traverse the named original/cleanup exception
branches, with explicit depth/count/visited bounds; retaining the exception
objects alone does not make their SQLSTATE visible.

**Why:** A live combined callback/rollback failure preserved both objects but
still appeared as unknown because its formatter inspected only linear causes.
Keep observation changes separate from retry eligibility.

**How to apply:** Verify both original SQLSTATE and cleanup transport failure
survive sanitized formatting without raw messages, SQL or arbitrary object
field traversal.

Do not equate application-side in-flight query time with active database
execution, or long wall-clock delays with high application CPU use.

**Why:** A primary snapshot observed ClientRead while the same published
process experienced multi-second scheduling delays with little consumed CPU.
Additional HTTP traffic changed scheduling conditions; it did not independently
prove the precise hosting or transaction-failure cause.

**How to apply:** Correlate native primary state with SQL-tagged process identity,
event-loop delay and consumed CPU. Qualify failed observation windows and traffic
comparisons; do not ship synthetic traffic, timeout relaxation or automatic
uncertain-outcome retries as a substitute for diagnosis.
