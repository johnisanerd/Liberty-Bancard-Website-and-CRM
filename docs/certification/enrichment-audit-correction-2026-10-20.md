# Enrichment audit corrections (read-only production evidence, 2026-10-20)

All figures come from read-only production queries and deployment logs taken about 23:30-00:05 UTC on 2026-10-20/21.
Committed code at the time: `170b61be` (not confirmed published by the owner); published build before it: `2c916700`.

## Corrections to the audit

| Audit statement | Verified state |
| --- | --- |
| "26 outreach-eligible businesses" | Distinct `business_id` values with status `validated_outreach_eligible` in the frozen historical table `sfp_outreach_eligibility` (71 rows, 29 Sep - 3 Oct). It is not current inventory. |
| 412 ready / 227 pending validation | Stale. Current launch inventory: 1,462 ready-held; 1,026 qualified recipients across 844 qualified businesses (844 primary, 182 alternates); 221 pending validation, none yet qualified. |
| Stored-vertical projection "unblocks 3,227 linked unvalidated contacts" | Not supported. About 5,050 verified-linked contacts with unvalidated/active email have no preparation at all. For 3,337 of them the business was never classified because the classification sweep routed it to `geography_review` (3,072) or `outside_territory` (265) before classification. 1,729 are classified and held for vertical or recipient reasons. |
| ~12k businesses "awaiting first classification" | The backlog read model counted businesses with a website and no completed evidence as ready for a first classification. 10,639 of them were never classified because their location is unknown or outside the territory. Of the Florida ones, almost all are outside Broward/Miami-Dade/Palm Beach (Orlando, Tampa, Jacksonville, Sarasota, Naples, ...). About 1,160 linked businesses have no city, state or address at all. |

The backlog now reports these as `classification_deferred_location_unresolved` and `classification_deferred_outside_territory` (held) instead of `awaiting_first_classification` (eligible now).

## Preparation performance finding

- Production preparation ticks: completion lane about 6 contacts per tick, priority lane about 22 contacts examined with 0 prepared; qualification costs about 2-3 s per contact.
- The priority candidate set (production contact, verified link, program and sequence binding, no live intent) is 1,829 contacts. 1,327 (73%) are suppressed (`email_status='invalid'`, no valid provider observation) and 502 are not. The lane spent its window qualifying suppressed contacts.
- Change: contacts without a live preparation that are suppressed get the screened hold `contact_suppressed_or_invalid` from the page query, without running qualification. The writer still rechecks all authority for every contact that passes the screen. The page cap rose from 4 to 40 pages; the lane deadline is still the real bound.
- Sub-phase timings (`qual_*`, `tx_*`) are now emitted in the existing `[CanonicalRecipientPreparation]` tick log so the next repair targets measured phases.
- Certification: `scripts/certification/test-recipient-preparation-lane-reserve.ts` (167 checks, disposable database, no provider traffic) covers suppressed contacts gaining no intent, decision row or membership while normal recipients still prepare.

## Not yet established (needs production data after publish)

- Serper: requests vs provider operations vs reported credits vs reservations vs actual balance. The 50,000 counter is not an enforced ceiling; the 500 total / 500 daily / 3 per request budget is unchanged and is not a global limit.
- Yield estimates in the audit have no stated sample, timeframe or denominator; treat them as estimates.
- Per-source (five upload family) distinct business, address, verified relationship, accepted vertical and qualified-recipient counts. Backlog snapshot: uploaded family 154,125 contacts, 140,596 held `LEGACY_CONTACT_FIELDS_ONLY`, 9,961 `CANDIDATE_NOT_INDEPENDENTLY_CORROBORATED`.

## Remaining work in this continuation

Territory-prioritised escalation order, location recovery from first-party website address for location-less linked businesses, Serper targeted email-discovery stage with usage accounting, validation de-duplication, legacy assignment and Sunbiz hold reconciliation. None of these change pauses, the Serper ceiling or ZeroBounce policy.

## Follow-up pass: geography recovery, validation, and items not built

Built and verified (disposable database, 87 checks in the geography-recovery certification; tsc clean):
- Geography recovery orders never-attempted businesses first, then businesses with a production contact, then Florida/blank state, then oldest attempt. It runs a four-worker pool and reads 60 parked businesses per tick instead of 15. It stays free and local: no provider call.
- Validation intent recovery now also picks up intents left in `processing` with an expired lease. Operation-key and address-claim guards still prevent a second purchase.

Findings (production, read-only, nothing here verified against the new build):
- Classification escalation: zero businesses are currently eligible, so territory ordering of escalation would change nothing. About 49k provisional businesses are name-only and can be closed only by a paid domain lookup.
- Validation queue is small (95 open intents). 64 intents (51 businesses) wait on addresses whose earlier ZeroBounce call timed out after dispatch. The address claim stays held by design ("unknown response is never authorization to spend again"). 109 such operations exist; releasing them means accepting a possible second charge of about one credit each and needs an owner decision. `provider_controls.zerobounce.reserved_units` (116) is a leaked-reservation counter, not a ceiling.
- Role addresses: 631 of 631 role-local-part addresses with a settled ZeroBounce result came back invalid (437 are `info@`), against 708 invalid / 1,340 valid for other addresses. This is consistent with ZeroBounce classifying role mailboxes as do_not_mail. The sub-status is not persisted, so it cannot be confirmed per address. No exclusion was added.
- Legacy assignment: 23,666 unlinked non-freemail contacts share their email domain with exactly one canonical business. A domain match alone is not independent corroboration under the link authority (`LEGACY_CONTACT_FIELDS_ONLY`), and adding a new evidence kind changes the pinned native link function. Not changed.
- Sunbiz legacy holds: 12,135 claims are held as `legacy_sunbiz_promotion_exists`. 1,471 have a retained contact (1,272 already completed by the supported retained path). The other 10,664 are prospects with no contact and no business (10,549 have a website). Completing them needs a business-only completion writer that preserves the original claim; not built.
- Serper email-discovery stage: not built. It needs a new provider-operation purpose, a memory kind separate from domain-lookup memory, and a way to turn a Serper-found address into evidence the native link function accepts (it accepts only first-party crawl evidence whose domain equals the business domain).
