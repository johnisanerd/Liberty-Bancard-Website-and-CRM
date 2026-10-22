---
name: Domain/location tick resumability
description: Why the automation tick must persist its cursor on a budget stop
---
Windowed automation ticks that stop on a time budget must save the last item handled as the cursor, with items processed in ascending id order.

**Why:** the domain/location tick ran only inside the 30-minute discovery job, and a budget stop left the cursor unchanged, so each tick re-evaluated the same first contacts and the cursor stayed at 0 for hours.

**How to apply:** for any bounded, windowed worker, check that partial progress is durable and no item is re-evaluated by a later tick of the same pass. Verify in production by reading the state row after a publish.
