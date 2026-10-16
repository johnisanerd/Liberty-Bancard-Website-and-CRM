---
name: Retained Sunbiz production rollout behavior
description: How the retained-source completion and upload receipts progressed in production after publish, and what the remaining holds mean
---
After publishing the retained-source completion build, the ordinary linker assigned ~1,274 of 1,424 retained legacy Sunbiz contacts; ~150 stayed as correct policy holds (ambiguous organization/filing, non-production class, weak identity, non-canonical business, location conflict). Upload recovery moved receipts from ~1,465 to 3,686 of 4,386 rows; the 700 left (626 organization ambiguity, 74 affiliation) are protected holds the worker keeps retrying.

**Why:** retained contacts that were behind the cursor when a build started are only reached on the next natural pass rollover; this looked like "no outcome" for ~200 contacts but was not a defect. Throughput in dense retained regions is ~11 contacts/min (resolver + setup), versus >1,000/min for unchanged contacts.

**How to apply:** after a publish, give pass-time estimates from observed per-region rates, not a flat rate. Do not treat contacts lacking a materialization outcome as stuck until the cursor has passed them in a pass that ran on the new build. Do not force or transfer holds to improve counts.
