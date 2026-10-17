---
name: Provider documentation contracts
description: External GHL, Apollo and Outscraper contracts that must be verified independently of fixtures and parser assumptions.
---

Verify a provider request against a known-valid resource before concluding that
configuration is its only defect.

**Why:** A nonexistent GHL calendar produced HTTP 400 and masked a second HTTP
422 caused by an unsupported query parameter. Known-valid calendars only
succeeded after the request itself was corrected.

**How to apply:** Keep diagnostics read-only and location-scoped. Test both valid
resource success and invalid resource failure; never silently broaden scope or
switch configured calendars to obtain success.

Outscraper `Pending` is not proof that an async task is still running: expired results also return `Pending`. The documented successful request response does not include a completion timestamp.

**Why:** The public request and Maps Search documentation checked on 2026-10-01 states that results expire four hours after completion. Assuming invented completion timestamp fields would reject supported successes; treating every `Pending` as progress could indefinitely extend access to expired work.

**How to apply:** Preserve the original request deadline and conservative retention bounds from genuine pending observations. Reject late observations without extending the prior cutoff; never label the first successful poll as the actual provider completion time. Check the current documentation when this contract is changed.

Apollo Organization Search and People API Search have different documented billing semantics.

**Why:** Documentation checked on 2026-10-01 prices Organization Search at one credit per page while People API Search is free. A common “search is free” default would understate paid usage.

**How to apply:** Use operation-specific documented defaults, preserve contradictory reported usage as a conflict, and keep request/person work separate from exact provider credit usage.

Apollo has no credits (owner-stated 2026-10-17), so continuing failed/ambiguous Apollo operations are expected, not a defect.

**Why:** The user said the failures are because there are no credits and should not be in task scope.

**How to apply:** Do not propose Apollo retry or error-typing work unless credits are restored.