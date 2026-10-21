# Production enrichment audit, 2026-10-20 (about 16:15 UTC)

Method: read-only SQL against production. Nothing was written, no provider was called, and pauses and provider
limits were not changed. Outbound global pause, email, SMS and cold-email channel pauses are all ON.

## 1. Population

| Layer | Count |
|---|---|
| Canonical businesses | 94,232 |
| Mapped to a target vertical | 6,398 |
| Unresolved vertical | 17,057 |
| Excluded or conflicting | 4,072 |
| Missing (name-only, no domain, phone or address) | 62,406 |
| No status computed yet | 4,299 (4,295 of them have a domain) |
| Canonical businesses with a website domain | 16,471 (3,835 mapped) |
| Production contacts | 160,104 (all lifecycle PROSPECT) |
| Contacts with a verified business link | 8,254 (5,289 businesses) |
| Contacts whose link evaluation is "legacy contact fields only" | 141,004 |
| Mapped businesses with a linked contact | 1,688 |
| Mapped businesses with a valid linked contact | 899 |
| Mapped businesses with a ZeroBounce-valid linked contact (30 days) | 916 |
| Mapped businesses with an outreach-eligible recipient | 26 |
| Launch-qualified primary recipients (global inventory) | 412 ready; 227 more pending validation |

The South Florida program is the only active one (3 counties, 5 verticals, taxonomy v2). The last funnel snapshot
(Oct 2) showed 2,408 in-target and 73,830 vertical-unresolved. It is stale.

## 2. ZeroBounce

- 3,453 completed operations (Sep 14 to now), 115 failed, 11 cancelled, 7 stuck "running" since Oct 2 to Oct 14.
- Ramped from about 50 a week to 800 to 1,300 a week after Oct 12. Today: 451 valid, 516 invalid, 40 timeout, 28 unknown.
- Local ceiling shows 3,453 of 50,000 consumed. Credits are not the constraint.
- Valid rate by source (last 14 days): free discovery 67% (n=243), outscraper 43.6% (n=2,616), historical backfill 36.5% (n=74, small).
- By address type: freemail 92% valid, named or other corporate 39%, role inboxes (info@, sales@ and similar) 0% valid. Of 691 role inboxes validated, 635 came back invalid. About 21% of recent spend bought nothing usable.
- 768 validation intents are blocked. 662 are "non_positive" and 106 are "ambiguous_billing". Those 106 need a look.
- Contacts by `email_status`: active 152,341 (legacy), unvalidated 4,345, valid 1,393, invalid 1,301. Only 856 of the 4,345 unvalidated have a validation intent.

## 3. AI vertical classification

- 113k evidence rows, total OpenAI cost about $99. 25.1k businesses classified target or non-target.
- 78.7k are provisional "review_required" with no website evidence, and 9.5k more are review_required and complete. More AI volume will not help these. They need a website or category first.
- Resolved: 4,177 resolved_high and 1,207 policy_accepted.
- The classifier walks businesses in ID order. Nothing prioritizes businesses that already have staged emails or a crawled domain. 3,801 of the no-status businesses and 5,541 of the unresolved businesses with a domain have no v3 classification.
- Stored-vertical projection: the business pass is complete (cursor 169,673). The contact pass is at 154,435 and still moving. 3,227 unvalidated linked contacts have a null vertical status until it finishes.
- The OpenAI control shows 10.86M units consumed against a 20,000 local budget. This is a unit mismatch, not real overspend. Worth correcting so the control is meaningful.

## 4. Serper

- 166,769 lifetime calls and 164,950 successes (98.9%). Last 10 days: about 99.5% HTTP success.
- Business-level yield is poor. Of 47.5k identity lookups, 2,467 (5.2%) accepted a match and 45,038 (94.8%) were rejected by identity checks. That is about 19 units per accepted business and 84 units per website found (567 websites).
- Email search: 8,586 calls found about 3,816 emails, roughly 2.2 calls per email. This is the efficient use.
- Local ceiling: 48,037 consumed plus 1,476 reserved of 50,000. About 490 units remain locally, so your remaining real credits cannot be used until a ceiling decision. I did not change it.

## 5. Staged and crawled emails (free)

- 27,469 free-discovery candidates, 27,466 staged for email. They cover about 5,240 businesses with 25.5k business-email pairs.
- Staged business verticals: mapped 1,314 businesses (6,669 distinct emails), unresolved 1,921 (5,424), no status 1,681 (7,089), missing 190, excluded 62.
- 1,919 staged first-party emails have no business ID. They need domain matching to a business.
- None of the staged pairs shows a ZeroBounce observation. Treat this as unconfirmed, because the staged hash may not use the same hash version as the observation table.
- Staged emails are not contacts. A validation intent needs a contact, so validating them needs the materialization step.

## 6. Legacy "active" contacts

- 152,341 production contacts have `email_status='active'`. All are historical imports: 100k-lead-file 89,848, 43k-lead-file 42,815, 26k-brands 9,371, cc-leads-june 9,045.
- Only 8 have ever had a ZeroBounce observation. 151,558 have no email token hash.
- Profile: 151,226 have a website, 149k are corporate addresses (3,881 freemail), 49,994 are in Florida, all have a vertical, and 55,997 distinct domains.
- Only 1,789 have a business link. 41,100 match a canonical business by website domain, but a domain match alone is not independent corroboration, so I did not link them.
- Priority slice: Florida, mapped vertical and non-role address is 21,444 contacts. 4,420 of those also match a canonical domain.

## 7. Sunbiz

- 1.9M entities. Active: 251,157 enriched, 657,244 classified only, 633 duplicates, 540 failed. Inactive: 962,642 still pending.
- Of the Active entities, 19,833 have a website. 4,736 are already canonical and about 15,100 are not.
- Bootstrap: 156,193 claims created, 66,103 deferred, 258 claimed. Rate is about 7,200 a day. 212,738 Active entities have a claim.
- Deferred reasons: 53,748 insufficient organization evidence, 12,135 "legacy_sunbiz_promotion_exists", 133 ambiguous, 112 identity review.
- Only 2,487 enriched Active entities have an email.
- The 12,135 legacy promotions were promoted through the old path and are the true re-run set for Sunbiz. At the current rate the remaining roughly 700k Active entities take over 3 months.

## 8. Master leads, prospects

- Master leads: 32 rows, all staged, all email-valid and linked to a business. Negligible.
- Prospects: 10,976 enriched (only 46 have an email), 1,559 converted, 172 raw.

## 9. Highest-return order (estimates, not measurements)

1. Finish the stored-vertical contact pass. It is free and unblocks 3,227 linked unvalidated contacts for preparation and validation. About 3,500 of the 4,345 unvalidated contacts still have no validation intent.
2. Classify staged-email businesses first, then crawled-domain ones. It is free and covers about 3,600 unresolved or no-status businesses and about 12.5k staged emails. This needs a code change and a publish.
3. Validate staged emails for the 1,314 mapped businesses (6,669 emails, about 6.7k credits). At free-discovery's 67% valid rate this is about 4,000 valid emails, the best return per credit. It depends on the materialization step.
4. Validate the 21,444 Florida, mapped, non-role legacy contacts in tranches, domain-matched first. At about 36% valid this is about 7,700 valid emails for about 21k credits. It gives the most volume but a lower return per credit, and all of them stay unlinked until independently corroborated.
5. Serper: stop name-only identity lookups for the 62k registry businesses (94.8% rejected). Spend on email search for the roughly 2,000 mapped businesses with a domain and no email found. This needs a ceiling decision.
6. Sunbiz: bootstrap the roughly 15,100 Active entities with a website that are not yet canonical, and re-run the 12,135 legacy promotions. Both are free.
7. Skip role inboxes in ZeroBounce validation. This saves about 21% of spend.

## 10. Limits of this audit

- "Marked as active" was read as the contact `email_status='active'` legacy value, plus Sunbiz legacy promotions. If you meant Sunbiz entity status "Active", section 7 covers it.
- The role-inbox filter used a fixed list of local parts. Valid rates for historical backfill rest on small samples.
- Launch inventory numbers are global, not per upload.
- The old funnel snapshot (Oct 2) was not re-captured.
