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
- Sunbiz legacy holds: 12,135 claims are held as `legacy_sunbiz_promotion_exists`. 1,471 have a retained contact (1,272 already completed by the supported retained path). The other 10,664 are prospects with no contact and no business (10,549 have a website). **Now built** (see below).
- Serper email-discovery stage: not built. It needs a new provider-operation purpose, a memory kind separate from domain-lookup memory, and a way to turn a Serper-found address into evidence the native link function accepts (it accepts only first-party crawl evidence whose domain equals the business domain).

## Sunbiz business-only completion (built after the follow-up pass)
- `server/services/retained-sunbiz-business-completion.ts`: a queue tick (100 entities per tick, `RETAINED_SUNBIZ_BUSINESS_COMPLETION_ENABLED=false` disables it) creates or matches a canonical business for contactless legacy prospects whose original claim is `deferred_collision` / `legacy_sunbiz_promotion_exists`. Scope: hot/warm sunbiz/cordata/corevt entities in the South Florida territory. About 10,640 contactless Florida entities are candidates in production; the territory filter narrows that.
- It uses the same resolver call and source-link representation as the retained-contact path, adds the identity-name guard from the bootstrap engine for matches, writes an audit row per completion, and leaves the original claim, prospect and ledger untouched. A monotonic id cursor in `system_settings` (`retained_sunbiz_business_completion_cursor`) keeps held entities from being re-resolved until the pass wraps.
- Certification: `scripts/certification/test-retained-sunbiz-business-completion.ts`, 41 checks on a disposable database (created, matched, non-canonical hold, out-of-territory, out-of-state, contact-bearing, cold score, idempotent replay, per-tick limit, authority-fence loss). Registered in the pre-deploy gate and suite manifest.
- Not verified in production until published. After publish, expect `[RetainedSunbizCompletion]` log lines and new `retained_sunbiz_business_completed` audit rows; new businesses then flow into classification and the free email crawl.

## 2026-10-21 continuation

### ZeroBounce bounded recovery (built, certified on fake data, never executed)
- One additional attempt per address, ever (UNIQUE row per address); original operations, attempts, observations and billing facts are not modified; the new attempt gets a new operation identity (`validation-intent:{id}:attempt:{n}` with the incremented count).
- Preview/authorize routes: `GET /api/lead-ops/zerobounce-recovery/preview`, `POST /api/lead-ops/zerobounce-recovery/authorize` (admin only, snapshot-bound by fingerprint). Authorization reopens intents and lifts the held claim once; it makes no provider call. The attempt still passes every existing gate (provider control/pause, DBPR, current recipient selection, 24h attempt bound).
- Fresh (30-day) valid/invalid receipts are authorizable at no cost and reused first; cooldown 24h from the original dispatch.
- Certification: `scripts/certification/test-zerobounce-ambiguous-recovery.ts` (40 checks, zero provider network attempts).
- Production read-only measurement before any execution: 112 distinct held addresses with an open need; 0 with a fresh receipt; 77 past cooldown, 35 inside it; maximum additional purchases = 112. Out of scope: 60 addresses whose legacy operations had vendor responses with unknown usage, and 31 intents that are not blocked.

### Legacy domain-based assignment evidence (measurement only, no acceptance change)
Population: 151,764 unlinked non-test contacts. 66 have no corporate domain; 110,899 have a domain that matches no business website; 27,019 match exactly one business; 13,780 match more than one. Territory uses the active South Florida geography resolver on the business location (single-match rows) or the contact's own city/state (multi-match rows, which have no ZIP); businesses with no state/city cannot be SFP.

Single-business domain match (27,019):
| Evidence | SFP | Nationwide | Total |
|---|---|---|---|
| domain + company + location agrees | 1,556 | 3,528 | 5,084 |
| domain + company, location missing on either side | 0 | 5,472 | 5,472 |
| domain + company, location conflicts | 623 | 7,669 | 8,292 |
| domain only (company differs/missing), location agrees | 100 | 13 | 113 |
| domain only, location missing | 44 | 5,933 | 5,977 |
| domain only, location conflicts | 1,448 | 633 | 2,081 |

Shared-brand check (the domain is used by contacts with more than one company identity): among domain + company + location agrees, 729 of the 5,084 (SFP 118, nationwide 611); among domain + company + conflict, 4,680 of 8,292.
Business origin: 26,810 of the 27,019 matched businesses are independently established (registry/provider/discovery); 209 were derived from contact records (all nationwide). Only 6 of the 27,019 contacts have a retained import/provider source event, so retained relationship evidence supports almost none of this population; existing automatic linking already handles those.

Multiple-business domain match (13,780): resolved by company and location 2,296 (SFP 80); same company at several locations (shared brand) 11; one company match with unconfirmed location 438 (SFP 107); company ambiguous 8,857 (SFP 268); no company match 2,178 (SFP 250). Contact-derived businesses are included in 354 of these.

Reading: the only evidence tier that agrees on domain, company and location without a competing identity is 4,355 contacts (SFP 1,438, nationwide 2,917) plus 2,296 resolved multi-business rows. Acceptance semantics are unchanged pending a decision on that tier.
