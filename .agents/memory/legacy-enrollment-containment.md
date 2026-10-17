---
name: Legacy enrollment producers are contained in code
description: Post-enrichment enrollment worker and unattended ZeroBounce auto-run cannot act regardless of pause state; how to verify and how to release
---
The legacy post-enrichment worker never creates an enrollment or GHL effect, and the unattended universe-wide ZeroBounce auto-run never starts, whatever the pause state or admin flag. Deals still get stamped/advanced and a durable pending intent (hold reason `legacy_enrollment_contained`) is kept; recovery claims nothing so attempt counts stay intact.

**Why:** the outbound pause is a temporary operating state, not enrollment authority; these producers bypass selected-recipient, validation and ready-held preparation. Production had no intents, runs, or recent audit rows, so this is preventive.
**How to apply:** release only by routing through the selected-recipient owners and flipping the containment constants in a reviewed change. A disposable test must prove the pause authority truly reports "allowed" (insert the control row and invalidate the pause cache) or it proves nothing. Disposable database names containing "prod" substrings (for example "producer") are refused by the infrastructure guard. Operator-launched ZeroBounce campaigns are still filter-based (DBPR-fenced, provider-control gated).
