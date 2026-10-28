---
name: Operational-truth patterns
description: Durable rules for retired entrances, derived totals, and rejection fencing of GHL identities
---
- Retired entrances stay registered and answer 410 after the auth/role gate; the emergency stop route stays live. History UIs are GET-only.
- Catalog status derives from package-version pins and retirement, never name or status. Step totals come from a grouped count, not a stored total.
- A provider rejection is recorded against the identity that was actually dispatched (claim-time fingerprint), and if the projection's desired generation advanced while the request was in flight the row returns to pending instead of terminal. Otherwise a corrected edit is fenced forever.
- GHL sync control refuses unselected runtimes, so fake-provider tests must assert the refusal rather than select the runtime.
**Why:** a code review caught the in-flight edit race; the other rules prevent misleading operator views.
**How to apply:** any new terminal or fingerprint-based suppression must be tested with an edit during the in-flight call.
