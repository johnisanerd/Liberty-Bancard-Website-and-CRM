---
name: GHL data-sync authority
description: One-way GHL-to-production contact synchronization, with no GHL record writes and outbound communications paused.
---

The current GHL sync requirement is one-way: GHL contacts supply information to contacts in the production database. Do not update GHL records. Keep outbound communications paused and keep provider spending and enrollment controls separate.

**Why:** The user clarified: “I don't need to update GHL records. The whole point is for the GHL contacts we have to sync with what we have in our prod db.” The earlier focus on writes back to GHL was the wrong direction.

**How to apply:** Match and reconcile GHL records into local production contacts without GHL mutations, communication/enrollment activation, or implicit changes to local authoritative fields. Native GHL action-safety review is not a prerequisite for reading GHL contacts. Do not simply enable legacy inbound writes without checking their local overwrite and downstream side effects.

For contact reconciliation, keep existing production values and use GHL only to fill missing contact details. Add identifiable GHL contacts that have no production match; ambiguous identities must be reported rather than silently merged.

**Why:** The user explicitly selected “Keep production values” and “Add them as new contacts” when asked how to merge GHL contacts into production.

**How to apply:** Preserve nonblank local details and protected consent/opt-out/ownership/status data. Use exact GHL-ID or normalized-email matching with collision checks, and use canonical local-only intake for genuinely new contacts without provider projection or paid-work hooks.

**Update 2026-10-23:** the owner confirmed GHL writes are now approved ("Confirmed GHL writes"), superseding the one-way-only scope. The native-review requirement below still applies: the agent prepares the review sheet, never approves it, and outbound/promotional pauses stay on.

If a future explicit request introduces writes back to GHL, require a fresh, location-bound native-workflow review covering exact operations, fields, custom-field IDs, tags and stages. The agent must not approve its own native safety review.

**Why:** GHL field, tag, contact and stage changes can trigger native communications even when the app's outbound messaging is paused.

**How to apply:** Keep the prior provider-write controls disabled for the current one-way scope; unsupported safety verification stays unverified and blocked.

Use explicit semantic pipeline/stage IDs, never title-only matching. Distinguish credential configuration, connection checks, enabled control, selected worker/owner, heartbeat, successful work, backlog/errors, and historical/current counts.

**Why:** The user requested truthful integration state rather than a single “healthy” indicator or historical totals presented as current synchronization coverage.

**How to apply:** Unknown or stale evidence must remain unknown or stale. GHL ownership and its isolated worker capability must not transfer SFP ownership, enable enrollment/voicemail, or change provider budgets or outbound pause.