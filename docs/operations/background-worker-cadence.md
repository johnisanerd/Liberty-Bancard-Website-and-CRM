# Conservative background cadence

This is a reduction in periodic wakeups, not a new worker pipeline, an activation
change, or a hosting change. It preserves all queued records and existing
authority, consent, provider, outbound-pause and lease checks.

| Existing queue | Previous repeat interval | New repeat interval |
| --- | --- | --- |
| Sunbiz full backfill | 1 minute | 5 minutes |
| Free enrichment lane | 15 minutes | 45 minutes |
| SFP free classification | 2 minutes | 10 minutes |
| SFP continuous discovery | 10 minutes | 30 minutes |

The changes trade faster background pickup for more time between heavy passes.
They do not guarantee a maximum run duration or establish that worker load caused
the observed idle-transaction failures. Free-enrichment timing came from retained
queue history, not a CPU measurement. Discovery and Sunbiz also had long runs
in live deployment logs; classification repeatedly found no work.

Import recovery remains serial with its one-minute production recovery schedule
and existing continuation mechanism. Event-driven consumers, validation,
qualification outboxes, all other cadences and safety heartbeats are unchanged.
The existing Sunbiz run-state gate still prevents work when the run is paused
or finished; the lighter schedule does not cancel or erase its backlog.

On the next publication, the existing scheduler replaces only each queue's own
base repeatable job. Named schedules, unrelated jobs and retained source records
are not deleted. Already waiting/active work may still run after publication.
Production intervals do not change merely because workspace code changes.

## Verification

`npx tsx scripts/test-background-cadence-cleanup.ts` checks the actual configuration
without connecting to any database, Redis or provider. It compares against the
pre-change Git configuration and permits only the four cadence edits, preserving
queue selection/order, concurrency, retries, named schedule definitions and
dispatcher, heartbeat and authority logic. The only additional scheduler change
is exact owned-schedule recognition for BullMQ's hashed repeatable keys.

After publication, compare `/api/admin/queue-metrics` with the table and observe
worker duration, waiting work and interactive response times. Do not declare
the original intake/business-assignment acceptance complete based on these
schedule changes.

## Hashed schedule identity repair

The first publication served the new interval configuration, but read-only Redis
inspection found both the old and new Sunbiz and free-enrichment schedules.
BullMQ v5 returns a hashed repeat key without the original `id`; filtering only
on `job.id` therefore failed to remove the old owned schedule.

The corrected existing scheduler reconstructs the exact BullMQ descriptor hash
using its known stable job ID and the returned schedule metadata. It recognizes
old intervals for that same owned schedule, without name-only or substring
matching. Base startup, named startup and the existing interval-update path use
the same predicate. Unrecognized custom keys remain untouched.

Replacement removes the obsolete periodic schedule and its next scheduled
wakeup through the existing BullMQ API. It does not erase imported source rows,
retained one-off jobs, unrelated schedules or currently executing work.
`scripts/test-owned-repeatable-schedule.ts` reproduces the missing ID against
the installed BullMQ with a private disposable Redis process and proves exact
replacement plus preservation of unrelated/named schedules and retained data.

This repair requires another owner publication. Effective-interval telemetry is
not proof that stale schedules are gone: inspect the actual installed repeat
registry after publication. Historical generation-scoped SFP namespaces are
not themselves evidence of current execution and are not blanket-deleted.
