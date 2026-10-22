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
Population: 151,764 unlinked non-test contacts. 66 have no corporate domain; 110,899 have a domain that matches no business website; 27,019 contacts have a domain that matches exactly one business; 13,780 contacts have a domain shared by more than one business. (These are contact counts; distinct business counts are smaller.) Territory uses the active South Florida geography resolver on the business location (single-match rows) or the contact's own city/state (multi-match rows, which have no ZIP); businesses with no state/city cannot be SFP.

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
Business origin: for 26,810 of the 27,019 single-match contacts the matched business is independently established (registry/provider/discovery); for 209 it was derived from contact records (all nationwide). Only 6 of the 27,019 contacts have a retained import/provider source event, so retained relationship evidence supports almost none of this population; existing automatic linking already handles those.

Multiple-business domain match (13,780): resolved by company and location 2,296 (SFP 80); same company at several locations (shared brand) 11; one company match with unconfirmed location 438 (SFP 107); company ambiguous 8,857 (SFP 268); no company match 2,178 (SFP 250). Contact-derived businesses are included in 354 of these.

Reading: the only evidence tier that agrees on domain, company and location without a competing identity is 4,355 contacts (SFP 1,438, nationwide 2,917) plus 2,296 resolved multi-business rows. Acceptance semantics are unchanged pending a decision on that tier.

### Measured yield of the independent domain/location tier (contacts versus businesses)
Read-only production sample (15 of 34 contact-id slices; ids 60,000-150,000 were not returned): 3,574 eligible contacts across 3,425 distinct businesses; South Florida 1,451 contacts / 1,417 businesses. Counting businesses by next action, about 120 South Florida businesses could realistically become new outreach recipients (about 3% of the eligible contacts). The assignment path (preview and apply routes, audited writer, no native contract change) exists but is manual; no recurring worker was built because of the low yield.

### Serper contact-page stage (built, certified on fake transport, closed by default)
- Selection: businesses the backlog reports as `website_searched_no_email_recheck` (accepted vertical in the active program, bound sequence, in territory, free website email search finished empty, no staged, main or contact email). Same ladder as the read model.
- One `/search` request per business through the existing gateway (`site:<domain> (contact OR "contact us" OR email)`), then at most three result pages on the business's own registrable domain are read with the bounded first-party reader. Only role inboxes are staged, as ordinary `first_party_contact_page` business evidence; the existing materializer, link authority and preparation do the rest. The stage creates no contact, link, enrollment, queue or send. Snippets and titles are never mined or stored.
- `serper_contact_page_lookups` (migration 0369; Publish owns DDL) is the claim (one active claim per business), idempotent operation key, retained provider evidence (query pin, result URLs/hosts/positions, returned field names, retrieval time, pages read), request count versus provider-reported credits (NULL when not reported), and remembered outcome (30 days for negatives, 7 for unreadable pages, 1 hour for failures; unchanged domain and rule version only).
- Gate: `serper_contact_page_stage` setting, closed unless `{enabled:true, perRunRequests:N}`; admin routes `GET/PUT /api/admin/serper/contact-page-stage` (GET also returns yield: requests, reported credits, staged, linked, qualified businesses, per-request and per-credit ratios, and whether credits were reported for every request). It shares no allowance with the unlabeled-discovery scope, and the Serper ceiling is unchanged.
- Certification: `scripts/certification/test-serper-contact-page-stage.ts` (33 checks, no provider network attempts).
- Not yet measured: additional qualified businesses per credit. That number only exists after the stage runs on production; it is not estimated here.

## 2026-10-22 continuation (read-only production measurements; nothing below is verified against a new publish)

Baseline (production, 2026-10-22 ~00:30 UTC). Units differ per row; rows overlap and must not be added.
| Measure | Value | Unit |
| --- | --- | --- |
| Canonical businesses | 98,943 | businesses |
| Mapped-vertical businesses (South Florida program verticals) | 6,046 | businesses |
| SFP-prepared (ready_held or pending_validation) | 1,282 | businesses |
| Ready-held | 1,137 businesses / 1,495 contacts / 1,409 unique addresses | each labeled |
| Pending validation | 249 | contacts |
| Verified link decisions | 8,420 | contacts |
| Unique valid addresses (<=180 days) | 1,449 | addresses |
| Backlog accepted verticals | 7,581 (2,007 with a supported linked contact) | businesses |
| Open validation intents | 883 | intents |

- Trace of the 961 mapped businesses with valid linked contacts: 960 are already ready-held; one (business 167865) is in `exception` (`CURRENT_RECIPIENT_FACTS_CHANGED`) and re-prepares.
- 466 mapped linked unvalidated contacts: 207 have no preparation and all are outside the territory (127 Florida businesses with only a non-South-Florida city, 22 non-Florida); 111 are blocked `ambiguous_billing` (needs the owner-excluded paid recovery); 26 are blocked `non_positive` (provider says undeliverable); 67 wait as `shared_address_validation_in_flight`; 21 processing; 91 rejected `FRESH_ADDRESS_REJECTED`.
- Validation finding: 58 of 63 addresses waiting as `shared_address_validation_in_flight` are held by the `legacyInFlight` guard in `canonical-address-validation.ts`. Earlier committed ZeroBounce operations whose observation is retryable (`unknown`/`risky`) no longer own the claim and count as in flight forever. Loosening the guard would trigger more paid retries; not changed.
- Staged emails: 26,553 candidates (5,431 businesses): 15,359 never evaluated, 7,049 held, 4,145 done. Held reasons: third-party domain 5,095, shared location domain 1,530, email not clean 268, placeholder 83, suppressed 44. Never-evaluated items are mostly structurally gated (shared address 11,208; 3-usable-contact cap 4,327). All 3,000 mapped businesses with a domain and no main email were already searched.
- Serper discovery drop (2,500-4,700 lookups/day to ~20-28/day): the official-domain selector is exhausted by lookup memory, not by the 50,000 display counter. 2,552 mapped businesses lack a domain; 2,442 have live lookup memory expiring Nov 2-20 (rejected 2,163, accepted_no_website 197, ambiguous 53, no_match 29). The Serper ceiling is unchanged; the unlabeled-discovery scope (62,225 businesses) stays closed.
- Item 5: the 77,308 `production`-class businesses are all registry-sourced (sunbiz entity links, no discovery source, 0 contacts, 1,230 with a domain, 72 of those sharing a domain with a canonical business). Class is not changed blindly. 12,686 enriched prospects (12,556 with a website, 10,228 distinct domains; 6,881 prospect rows match a canonical business domain exactly, 330 match a production-class business). The retained Sunbiz completion path already produced 5,345 businesses; no new automatic reconciliation was added.
- Status funnel repair (`/api/lead-ops/pilot/status-overview`): replaced the single 2.5 s statement (two full Sunbiz scans) with independent blocks, each with its own limit and availability. Current facts come from `cr04_enrollment_intents`, `validation_intents`, and paused memberships; `sfp_outreach_eligibility` and `sfp_ready_held_enrollments` are returned under `historical` and labeled frozen (production: 31 frozen ready-held versus 1,495 current ready-held contacts). Source-row count is a planner estimate; the eligible sample is no longer computed there.
- Automatic domain/location assignment: `contact-domain-location-automation.ts` runs the existing policy and audited writer from the continuous-discovery tick. Closed by default; `GET/PUT /api/admin/contact-business-domain-location/automation` (admin) enables it and records the administrator as authorizer. Conflicts are preserved, validation and vertical never gate it, and it sends or enrolls nothing. Certified in `test-domain-location-assignment.ts` (disposable database). Measured yield remains small (about 120 new South Florida recipient businesses).
