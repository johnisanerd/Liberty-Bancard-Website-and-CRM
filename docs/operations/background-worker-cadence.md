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
queue selection/order, concurrency, retries, named schedules and dispatcher,
heartbeat and authority logic.

After publication, compare `/api/admin/queue-metrics` with the table and observe
worker duration, waiting work and interactive response times. Do not declare
the original intake/business-assignment acceptance complete based on these
schedule changes.
