# Liberty Bancard — SFP campaigns, sequences, copy and launch audit

Audited October 19, 2026, through approximately 01:28 UTC (October 18, 9:28 p.m. Eastern).

Updated October 18, 9:38 p.m. Eastern to make reuse of existing campaign/sequence content the primary implementation approach. This is a document clarification using the completed audit, not a new production measurement.

Repository: `scottpstevenson/Liberty-Bancard-Website-and-CRM`. Main was checked at the beginning and end: `16cb70ebb94f2d7dc02cb7b993be77a382b88b94`. Production CRM: https://libertybancard.com. The preceding enrichment audit verified the served application revision `59ea7da584ebef2ce025277842d10f4f90c944d7`; the publication commit adds no file differences. Live inventory and configuration below were read again for this audit.

## Decision

**The CRM is not ready to launch the proposed SFP outreach. The most immediate blocker is that all five SFP sequences and their five campaigns have no actual content steps.** This is independently visible through the live read APIs and explained by the package-convergence code, which creates governance shells rather than copying or authoring email content.

The shortest useful route is one focused SFP launch repair: **reuse and correct the strongest existing campaign/sequence content to populate the five packages**, repair and certify the existing canonical preparation-to-release path, and launch a small continuously replenished recipient queue through a verified transport. The library already contains 49 email steps across ten older campaigns and 288 sequence email steps, including duplicates. The five empty SFP packages do not imply the existing library needs to be rewritten. Continue local enrichment alongside it. Do not wait for all nationwide contacts or all Sunbiz filings to be resolved. Do not launch the same recipients through both Campaigns and Sequences.

No code, live content, settings, enrollments or provider controls were changed. No emails, SMS, calls, enrollments or paid provider work were initiated. Existing outbound pauses remain on. This is an audit and a concrete implementation/launch brief, not a delivery certification or a claim of perfect inbox placement.

## 1. Exactly what was inspected

| Live object | Coverage | Result |
| --- | --- | --- |
| Sequences | All 122 returned by the signed-in sequence inventory, and every sequence's step reader | 90 paused; 32 active; 487 actual steps |
| Sequence email steps | All 288 inspected for merge-field/link/content patterns | 261 distinct body strings; no B variants present |
| Other sequence actions | All inventoried | 129 SMS; 29 calls; 24 voicemail drops; 14 tasks; 2 call reminders; 1 wait |
| Campaigns | All 18 returned by the signed-in campaign inventory and every campaign's step reader | 17 draft; 1 active; 50 actual email steps |
| Campaign copy | Full subject, body and stored AI instruction review of the 49 steps in campaigns 2–11, plus the test campaign's step inventory | Five SFP campaigns have zero copy to review |
| Saved message templates | All 8 | Six email and two SMS templates; all marked active |
| Signatures and configuration | Live signature, identity, activation, readiness, outbound-settings, deliverability-settings and cold-email-health readers | Conflicting readiness/capacity definitions; actual pauses confirmed |
| Execution code | Package authoring/hash, canonical preparation context, enrollment routes, bulk enrollment, scheduler, worker, renderer, SMTP/GHL transports, send claims, replies, suppression and unsubscribe | Concrete launch defects below |
| Public landing destination | Opened both `/upload` and `/upload-statement`, without submitting anything | `/upload` renders 404; `/upload-statement` renders the statement form |

All 288 sequence emails were included in systematic field and link checks. Detailed editorial review covered W6 launch copy, the campaign library, saved templates, and the legacy sequence claims/audience examples identified below. This does **not** certify every legacy email's product claims, every device rendering, hidden GHL-native workflow, or external delivery configuration. Those objects must remain outside the launch allowlist unless specifically certified. The inventory is what this signed-in account can read, not a claim to inventory every external GHL asset.

No full repository build or disposable PostgreSQL suite was rerun in this environment. Twelve isolated checks against extracted current rendering functions and current route text passed, with fixtures and no database/network/provider access. They reproduce defects; they are not release approval.

## 2. Empty launch packages: verified live

| Vertical | Sequence ID | Displayed steps | Actual sequence steps | Campaign ID | Actual campaign steps | Memberships displayed in CRM |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Automotive | 1153 | 5 | **0** | 82 | **0** | 314 |
| Healthcare | 1154 | 5 | **0** | 83 | **0** | 726 |
| Beauty/Spa | 1155 | 5 | **0** | 84 | **0** | 375 |
| Construction/Trades/Home Services | 1156 | 5 | **0** | 85 | **0** | 307 |
| Fitness/Recreation | 1157 | 5 | **0** | 86 | **0** | 203 |

All five sequences are paused and all five campaigns are draft/unreviewed. The 1,925 displayed memberships are not 1,925 fresh validated recipients or send authorizations. They include retained membership history and must be reconciled against current preparation and address evidence.

Evidence: `GET /api/sequences`, `/api/sequences/{1153..1157}/steps`, `/api/campaigns`, `/api/campaigns/{82..86}/steps`, and the Outbound Center cards. These requests returned valid collections, not permission errors. W6 sequence 85 returned five steps through the same reader, so the empty SFP results are not simply an unavailable steps endpoint.

Code cause: `applyPackageConvergenceV2()` in `server/services/cro03/sfp-campaign-packages.ts`, around lines 635–680, inserts a draft campaign and a paused sequence, copying W6 metadata and `total_steps`. It inserts no content rows there. Existing current versions are returned as `already_current` without checking that steps exist. `verifyPackageConvergenceV2()` checks parent statuses and bindings, not a valid nonempty sequence.

**Required repair:** select and correct existing launch content using Section 6's reuse map, store real ordered steps in the current SFP packages, calculate parent counts from children, and publish a new content-pinned package version through existing supported writers. Write new wording only where the selected source content has a genuine gap. Do not silently mutate an immutable package hash, reset imports, or duplicate existing preparation memberships. Ordinary preparation must reconsider affected content pins. Add a nonempty executable-content check before a package is considered launchable, and prevent an empty sequence being recorded as a successful exhausted/no-response journey. The worker currently reaches completion when `currentStep >= steps.length` if earlier gates permit execution.

The older W6 sequence is a useful structural source. Its unsupported savings claim and broken upload destination need correction before its content is reused; these defects do not require discarding the rest of that work.

## 3. Launch execution is independently disabled

### Three distinct controls currently stop work

1. **The sequence runner is behind `LEGACY_OUTREACH_ENABLED`.** Live activation reports it false, with sequence-runner and SLA heartbeats dated September 5. `queue-manager.ts:2032–2039` only calls `runSequencesTick()` when this flag is true. A scheduled queue job can therefore run without processing sequence memberships.
2. **CR-06 denies promotional lifecycle execution.** `cr06-promotional-lifecycle-decision.ts` returns `CR06_PROMOTIONAL_EXECUTION_DISABLED` for promotional/default purpose. The worker checks it at claim; enrollment and bulk routes also use it. Marking cold email as transactional is not a repair.
3. **Global and channel pauses are on.** Fresh live settings: global paused, email paused, cold-email paused, SMS paused. The configured cold-email daily cap is 200 and today's count is zero.

The live activation API reported 415 active enrollments but zero recent sends. The UI also displays historical active/completed counters; these must not be used as proof that a launch is running. Enabling a global flag could expose unrelated legacy memberships to evaluation.

**Required repair:** provide one explicit SFP release authority in the existing execution path. It must bind current canonical preparations, exact address, program/sequence and content revision, allowed channels, sender, budget and pause epoch. The ordinary runner must actually process this scoped work while other legacy producers remain contained. A global boolean flip or blanket resume is not sufficient. No new frozen cohort is needed.

The existing pause/resume route only pauses: a paused membership returns HTTP 409 for resume. The general enrollment update route also does not expose status changes. Therefore the UI's Activate/Unpause controls are not an implemented canonical bulk-release mechanism.

The Ready for Outreach email start route still requires `cohortRunId` before reaching an authority that supports canonical email preparation. Its list rejects existing active/paused memberships, so it does not represent the current ready-held population. Adapt that existing screen/action to canonical preparation, rather than operating old cohort controls or adding another enrollment system.

### One scheduling owner

Use the CRM sequence worker for SFP timing, qualification and membership ownership. Use one verified delivery adapter. GHL contact upsert/tags may remain integration functions. Do not simultaneously run native GHL outbound workflows for the same journey. Missing GHL workflow-ID badges and the readiness requirement for 5 of 39 workflow IDs are not, by themselves, dependencies of CRM-owned sequence delivery.

## 4. Sender, capacity, replies and delivery

### Observed capacity does not agree

| Reader/control | Fresh result |
| --- | --- |
| Stored sending identity | One identity; `isActive=true`; daily limit **30**; zero sent today; health score 100; no `status` property returned |
| Activation-status reader | Calls that one identity active |
| Readiness-checks reader | Reports no active sending identities/capacity |
| Cold sequence cap | **200/day** |
| Delivery warmup | **Off**, start date null |
| Delivery thresholds | Bounce 5%; complaints 0.1%; unsubscribe 5% |
| SMTP | Configured; no live SMTP delivery test performed |
| GHL | Auth probe succeeded; this proves credentials, not email delivery |
| Cold-email-health | Mailing-address setting, token secret and APP_URL present; these existence checks pass |

`activation.ts` explains the identity contradiction: one reader accepts `isActive !== false && status !== 'paused'`; another requires `status === 'active'`. The returned identity lacks that property. The sequence worker's cold-send counter uses `outboundDailyEmailCap`, plus a separate optional date-based warmup schedule; its inspected path does not derive its cap from this identity's 30/day value. A displayed identity health score is not externally verified reputation.

**Required repair:** use one actual capacity definition at admission and dispatch. For the first launch, cap total daily messages at the lower verified transport/sender/program capacity and include follow-ups in that total. Do not infer permission to send 200/day from the global setting or 50/day from an old wizard display. At 30 messages/day, 562 first touches alone take at least 19 sending days; three touches would require at least 57 sending days if everyone receives all three. These are capacity illustrations, not forecasts of the eligible pool. Scaling sender capacity is a later evidence-based operation, not a reason to delay fixing release.

### Actual SMTP versus GHL behavior

`sequence-worker.ts` prefers configured SMTP for cold email, and otherwise uses GHL; non-cold sequences use Gmail OAuth. Both primary marketing transports call the compliance renderer. This corrects any earlier simplification that GHL necessarily delivers all SFP messages.

The SMTP cold sender policy sets Reply-To to `Scott@mail.libertybancard.com`. The GHL fallback explicitly sets Reply-To to `scott@libertybancard.com`. The sequence worker appends the hardcoded signature via `getEmailSignatureHtml()`, whereas the live signature editor returns stored profiles, including a different sales contact address. Updating the signature UI therefore does not by itself prove sequence rendering changed.

**Required repair/proof:** select one monitored reply destination, resolve sender/signature consistently, and show that a reply received at that actual mailbox creates a canonical inbound event, stops the current journey, and reaches the human sales inbox. A monitored inbox alone does not prove the CRM ingests its replies. Do not let SMTP failure silently fall back to a different provider with different reply/suppression behavior unless that route is explicitly certified.

### Provider policy and message authentication

HighLevel's official public guidance is not a blanket authorization for a cold blast. Its deliverability page says permission-based marketing and rejects cold/purchased lists; its support guide discusses cold outreach separately and recommends isolated, purpose-built tooling for it. Establish which SMTP/LC service actually delivers this account and its applicable terms before using the fallback for scraped/registry cold data. Warm permission-based inbound follow-up and cold prospecting should have explicit, appropriate delivery treatment while sharing canonical CRM qualification and suppression.

References: [HighLevel deliverability](https://www.gohighlevel.com/email-deliverability), [HighLevel sending guide](https://help.gohighlevel.com/support/solutions/articles/155000001021-email-sending-guide-email-best-practices-email-warm-up).

No inbox/header sample, SPF/DKIM/DMARC alignment, return-path/PTR, SMTP account policy, external reputation, or recipient-side placement was independently certified. A configured checkbox is insufficient. Obtain a controlled seed delivery and inspect actual headers before a customer batch; this audit did not send one.

## 5. Copy and rendering defects

### A. Wrong merge-field language in Campaigns — high priority

The live campaign library uses `{{firstName}}`, `{{companyName}}`, `{{agentEmail}}`, `{{agentName}}` and `{{agentPhone}}`. Both current campaign generators replace only `{{first_name}}`, `{{last_name}}`, `{{company_name}}`, `{{vertical}}`, `{{city}}` and `{{state}}` before optional AI. Their AI fallback returns the unresolved template. No general unresolved-token rejection was found in the inspected campaign generator/send paths.

An isolated execution of the current contact generator with AI off reproduced unchanged camelCase tokens. All 18 live campaign parents have `aiPersonalization=true`, including placeholders, but a model success must not be the mechanism that makes deterministic recipient fields valid. AI failure/flagging reintroduces the problem; stored per-step AI instructions are also not automatically proof the sender uses them.

Repair with one deterministic, documented render contract shared by previews and real sends. Validate subject, HTML, text, URLs and both variants; reject unresolved tokens before a claim reaches a provider. Escape recipient values for their HTML/URL context and use callback replacements so dollar-sign sequences in source values cannot act as replacement directives. The extracted sequence renderer also preserved HTML markup inserted through company name.

### B. Sequence-only unsupported booking field

**43 SMS steps** contain `{{custom_values.booking_link}}`. The current local sequence renderer does not support that field and explicitly throws on unresolved tokens. These are SMS defects, not 43 broken email steps. IDs include 15722/15725/15727 in sequence 58 and 15746/15749/15751 in sequence 61. Normalize these only if those sequences are retained for an authorized SMS use; keep SMS, automated calls and voicemail out of the initial cold-email release.

### C. Broken or misleading CTAs

**35 sequence email steps** have an Upload-labelled button pointing to `https://api.leadconnectorhq.com/widget/bookings/libertybancard`, which is a booking URL rather than the statement-upload form. Examples: step 15723 in sequence 58; 15747 in 61; 15870 in 76; 18962/18966 in 49. Full affected sequence/step pairs are in Appendix A.

W6 email steps 19010, 19012 and 19014 link to `/upload`, which was opened and renders a 404. The functioning inspected destination is **https://libertybancard.com/upload-statement**. The destination explicitly instructs merchants not to email financial documents; many campaign emails instead ask recipients to forward a statement to `{{agentEmail}}`. Align email requests with the secure upload policy.

Several distinct booking paths are embedded in templates, signatures and the worker's calendar fallback. Standardize one actual working calendar; verify it offers slots, assigns the right owner and creates the intended inbound transition. Merely loading the upload form does not certify submission/receipt/analysis.

Saved email template **4, Day 7 Review Request**, contains literal `[GOOGLE_REVIEW_LINK]` in its href. Curly-brace checking will not catch it. Supply a real reviewed review URL before that merchant-success journey is used.

### D. Claims and math need correction, not another disclaimer

| Live object | Problem | Required disposition |
| --- | --- | --- |
| W6 sequence 85, step 19010 | “most find 10–30%” unsupported by evidence inspected | Remove from the launch source template unless substantiated |
| Active sequence 61, steps 15745/15750 | 20–35% and $200–$600/month savings claims | Replace with statement-specific comparison offer |
| Active sequence 58, steps 15721/15724 | HSA/FSA routing and high-ticket procedures described as automatically unlocking lower healthcare/corporate interchange | Product/card-program substantiation required; high ticket size is not evidence the card is corporate |
| Active sequence 83, step 19004 | Purported client quotation/results | Need an approved real testimonial and permission or remove |
| Sequence 36, steps 18917/18921 | Apparent invented industry case study, expiring estimate, guaranteed limited-time pricing, and numeric savings | Hold this whole sales path until actual analysis/offer evidence drives it |
| Campaign 8, step 31 | Says 2.6–2.9% on $3,000 is $26–$87 | Correct arithmetic is **$78–$87**, before any fixed fees; remove generic savings conclusion |
| Campaign 4, step 12 | Compares $1,620 flat-rate bill to $960 interchange-only as though $960 is full interchange-plus cost | Include actual markup/assessments/fixed fees or remove the numerical comparison |
| Campaign 2, step 4 | “hundreds” of local analyses and 70%/30% outcomes | No substantiation inspected; remove or supply approved evidence |
| Campaign 11, step 47 | Broad claim that named booking platforms support swapping in any processor without workflow change | Verify each supported integration before naming it |
| Multiple legacy sequences | Guaranteed no downtime, no cancellation fees, same-day funding, free equipment, HIPAA/PCI/security assurances | Bind to actual contract, product, underwriting and implementation facts; do not launch as universal claims |

Additional examples include seqs 55–81's volume/savings/collections improvements, seqs 24–35's repeated percentage claims, and old PCI/chargeback/surcharge advice. The existence of an eligibility disclaimer does not substantiate the preceding statement. No claim is labelled false solely because proof was unavailable; it is **unsubstantiated for this launch** until evidence is provided.

The worker currently derives `estimatedSavings` from annualized `contact.estimatedResidual`. A residual estimate is not an observed merchant saving. Remove this substitution from customer savings copy; accept a current, attributable statement-analysis result instead.

Several nurtures assume a prior call, completed analysis or existing merchant relationship. Saved template 5 even says the numbers have not changed. Those need the corresponding lifecycle evidence; do not use them for new cold contacts.

### E. Cadence is relative, not a day label

The worker adds each next step's `delayDays`/`delayHours` to the time the preceding step executes. W6 stored delays 0,1,3,4,7 produce approximately day **0,1,4,8,15**, not day 0,1,3,4,7. Queues/quiet hours may extend them. Record both relative delay and intended cumulative schedule in the launch package and test the actual scheduler with a fake clock.

### F. Unsubscribe is not yet a certified one-click implementation

SMTP advertises `List-Unsubscribe-Post: List-Unsubscribe=One-Click` pointing at the signed `/unsubscribe?t=...` URL. The inspected public router implements **GET**, with durable consent writes; no POST handler was found there or in the repository unsubscribe search. Google's documented one-click action sends an HTTP POST. Thus the advertised one-click contract is incomplete in the code inspected, even though a clicked GET link can work.

Add an idempotent signed POST handler using the same canonical consent/suppression authority and cover both channels of opt-out. Do not test with an actual production recipient token during a read-only audit. Prove opt-out affects every marketing path, not just the visible sequence. Keep the body link and valid mailing address, and make commercial purpose clear.

References: [Google sender requirements and POST example](https://support.google.com/mail/answer/81126?hl=en); [FTC business guidance](https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business). These apply differently from a mere provider-enable setting. B2B email is not exempt from the FTC commercial-email rules.

## 6. Reuse existing content to finish the five SFP packages

**Reuse is the primary plan.** Replit should select the strongest existing steps, make the specific corrections from this audit, and populate/version the current five packages. The new draft copy later in this section is optional fallback wording, not a requirement to replace the existing library.

### Existing content and recommended reuse

| Existing source | Verified content | Recommended use | Corrections before reuse |
| --- | --- | --- | --- |
| Campaign 2 — SDR-01: Statement Review Cold Outreach | Five email steps, IDs 1–5 | Main statement-review offer and conversational base; steps 1, 2 and 5 are the first candidates for a short initial sequence | Use secure upload instead of forwarding documents; remove fake reply prefixes unless genuinely threaded; remove unsupported claims; normalize fields and service turnaround wording |
| Sequence 85 — W6 Cold Outreach: Email + Manual Call | Five steps: emails 19010/19012/19014 and manual tasks 19011/19013 | Governance, email/manual-task structure and useful fee-review language | Correct `/upload` to `/upload-statement`; remove “most find 10–30%”; test relative delays; manual tasks remain optional and never become automated calls |
| Campaign 6 — SDR-05: Medical / Dental / Medspa | Five email steps, IDs 21–25 | Healthcare-specific opening and relevant payment-workflow wording | Retain only supported product capabilities; no unsupported EHR integrations, universal savings or compliance assurances; secure upload CTA |
| Campaign 8 — SDR-07: Auto / Service / Trades | Five email steps, IDs 31–35 | Automotive and Construction/Trades/Home Services variants | Correct $3,000 arithmetic; avoid treating all contractors as auto shops; qualify equipment/funding/cash-discount statements; use only the relevant vertical wording |
| Campaign 11 — SDR-10: Salon / Spa / Beauty | Five email steps, IDs 45–49 | Beauty/Spa-specific opening and relevant tips/payment language | Verify any named booking-platform integration; qualify equipment claims; remove generic guaranteed savings; secure upload CTA |
| Sequence 67 — V-Gym: SDR Outbound Prospecting | Seven actions, including four email steps | Candidate source for Fitness/Recreation vocabulary where actual subtype fits | Reuse relevant language only; remove unsupported decline/savings statistics and recurring-interchange claims; do not copy its SMS steps into the cold-email package |

Campaign 2's fourth step (ID 4) is not a safe social-proof source without substantiation for its “hundreds” and 70%/30% claims. The older active vertical sequences are additional sources of wording, not permission to activate their entire journeys. IDs identify the audited production objects; implementation must resolve and verify logical identity in its own environment rather than hardcode production serial IDs into migrations.

Use the corrected shared statement-review core across the five packages and tailor the opening to each vertical. There is no need to invent 15 unrelated offers or force every existing email into the initial launch. Subtype-specific statements must fit the actual business; a broad Healthcare or Fitness/Recreation label alone does not prove it is a dental practice or a recurring-membership gym.

### Required content-reuse deliverable

For each selected launch step, record the original campaign/sequence and step identity, the original content revision or hash, the revised subject/body, intended audience, relative delay, actual CTA destination and a short reason for each substantive change. Present the exact rendered result for a named contact, role mailbox and missing-name case. This makes the final package reviewable without requiring the user to inspect hundreds of old emails or manually approve each recipient.

Preserve the source library and history. Avoid global edits to a shared legacy step that could change an unrelated active journey. Store adapted content through supported package/step writers, create the correct new content version and binding, and let canonical preparation reconsider stale content pins. Verify that existing memberships are reused rather than duplicated. Author only the missing pieces and keep a clear source-to-launch-step mapping.

The campaign records can remain content sources/package artifacts while the current CRM sequence worker remains the single SFP scheduling owner. Copying campaign wording into the canonical sequence does not authorize parallel campaign-queue sends to the same recipient.

### Suggested initial journey

Use one current sequence per v2 vertical, driven by canonical preparation, with **three email touches** and no automatic SMS/call/voicemail. Optional human call tasks can be added later without turning a cold email contact into automated-call consent. Prefer short deterministic copy initially; no per-send AI is needed for a valid launch.

Suggested timing: day 0, day 3, day 8 in recipient/South Florida business hours, weekdays. In this worker that means relative email delays **0,3,5 days**, followed by quiet-hours adjustment. Use real email threading only if supported with the actual message IDs; do not prepend fake `Re:` to unrelated sends.

### Optional fallback drafts — use only where selected source copy needs replacement

The drafts below provide concrete alternatives for gaps or problematic passages. Replit may instead retain corrected existing wording when it meets the same rendering, claims, CTA and lifecycle requirements. This is one content-reuse/launch-repair task, not a separate full copywriting rebuild.

#### Touch 1 — per-vertical opening

Use `Hi {{firstName}},` only when the renderer has a genuine supported person name. For role mailboxes, company-name placeholders and missing names, render **Hello,**. Do not greet “Precision Auto Glass Contact” as a person. The sign-off and postal/opt-out footer are composed once from the resolved sender, not duplicated by template plus signature.

| Vertical | Subject | First paragraph |
| --- | --- | --- |
| Automotive | Payment processing at {{companyName}} | I’m reaching out from Liberty Bancard about payment processing at {{companyName}}. We can review how your repair invoices and day-to-day card payments are priced. |
| Healthcare | A processing review for {{companyName}} | I’m reaching out from Liberty Bancard about payment processing at {{companyName}}. We can review your patient-payment processing statement and explain its fees. |
| Beauty/Spa | Payment processing at {{companyName}} | I’m reaching out from Liberty Bancard about payment processing at {{companyName}}. We can review how your card payments, tips and any recurring charges are priced. |
| Construction/Trades/Home Services | Card payments at {{companyName}} | I’m reaching out from Liberty Bancard about payment processing at {{companyName}}. We can review the fees on your card-paid invoices and deposits. |
| Fitness/Recreation | A processing review for {{companyName}} | I’m reaching out from Liberty Bancard about payment processing at {{companyName}}. We can review the fees on your card payments and any membership billing. |

Continue every variant:

> The review separates network costs, processor markup and fixed fees. There’s no obligation to switch, and we’ll tell you if your current pricing is already competitive.
>
> Would a free statement review be useful? You can use our secure upload page: https://libertybancard.com/upload-statement
>
> Scott Stevenson
> Liberty Bancard
> 954-266-8214

These are **optional proposed replacement drafts**, not live copy or a required replacement for the audited library. “We can review” describes the existing published service; do not add unverified integrations or savings results. Use one main CTA, not a large signature with competing shop/quiz/calendar promotions.

#### Touch 2 — same content across verticals

Subject: `A clearer breakdown of your processing fees`

> Hello,
>
> Following up on my note about {{companyName}}. A statement review shows your total effective rate as well as the individual fees behind it, so you can compare options using the same transaction volume.
>
> If you’d like that breakdown, our secure upload page is https://libertybancard.com/upload-statement. Please use the form rather than emailing financial documents.
>
> Scott Stevenson
> Liberty Bancard
> 954-266-8214

#### Touch 3 — stop rather than recycle into another cold journey

Subject: `Should I close the loop?`

> Hello,
>
> I’ll close the loop on my processing-review offer for {{companyName}}. If it would be useful later, you can reach me here or request a review at https://libertybancard.com/upload-statement.
>
> No need to reply if the timing isn’t right. This is my final follow-up on this offer.
>
> Scott Stevenson
> Liberty Bancard
> 954-266-8214

For **all three**, add a clearly visible “Commercial message from Liberty Bancard” line, the real configured postal address, and the rendered signed unsubscribe link. Never ship bracketed placeholders as copy. Any reply stops cold automation for human handling; a statement receipt moves into the actual statement-analysis lifecycle, not another blind chase. No-response completion must not automatically re-enroll the same business in an overlapping legacy campaign.

## 7. Which leads to enroll first

The preceding read-only enrichment audit at roughly 00:34–00:40 UTC recorded 562 ready-held canonical preparations, 730 pending-validation preparations, 6,102 verified contact links across 4,111 businesses, and 5,817 current effective vertical assignments. These are **earlier timestamped measurements**, not fresh launchable-recipient counts. The exact intersected sendable SFP count has not been established.

Use this order:

1. **Reconcile existing ready-held preparations first.** Re-read exact business, current effective vertical, normalized three-county geography, current email/address receipt, source/DBPR/quarantine rules, suppression, contact relationship, lifecycle and one current program/sequence/content binding. Reuse the owned paused membership. Produce distinct business and normalized-address counts and one explicit reason for every hold.
2. **Then finish pending validation for otherwise qualified local recipients.** Reuse fresh validation receipts, settle shared-address work once, and recover failed/ambiguous/stale operations without blindly buying another validation. A “valid” contact status is not proof of a current exact-address receipt or permission to send.
3. **Feed the queue from the staged first-party backlog and businesses already holding email/site evidence.** Prioritize the three counties and current five verticals in the existing drain/classification worker. Materialize and link supported candidates, accept supported verticals, prepare and validate them automatically. Do not force links or accept guessed verticals to fill volume.
4. **Use paid discovery only for the next missing fact that would make a local business usable.** Prefer local businesses with an accepted vertical but no usable mailbox/site, or a known site/email with just classification missing. Keep #2090's repeat-lookup protections and approved credit controls. No requirement to buy websites for every Florida filing.

Select **one primary mailbox per distinct business** for initial cold outreach. Alternatives remain available for an evidence-backed replacement, not parallel blasts to three staff members. Deduplicate normalized addresses across contacts, import uploads, source families and concurrent programs, while preserving distinct business locations and genuine conflicts. Existing-customer, inbound, referral and cold journeys must not compete for the same person.

The 152k nationwide-unlinked population remains #2091's assignment scope; it is not the denominator for the first SFP launch. Likewise the 1.9m raw filings need not all be canonicalized or classified before outreach begins.

## 8. One implementation continuation, then one launch decision

Keep the first release small in scope: **“Finish SFP campaign content and canonical outbound release.”** Do not make a new backlog UI a prerequisite, split every defect into a task, or combine this with nationwide identity recovery. Enrichment tasks continue their own bounded work.

| Build phase | Concrete output and acceptance |
| --- | --- |
| Package/content repair | Reuse map from existing campaign/sequence steps to five real SFP sequences; corrected subjects/bodies and rendered previews; real child counts; valid CTA URLs; immutable version/hash; existing preparations reconsidered without duplicate memberships. No full-library rewrite required |
| Render/compliance repair | One deterministic renderer; safe named/role/missing-field fallbacks; no unresolved or bracketed tokens; correct HTML/plain text; correct math; one footer; signed GET/body link and POST one-click opt-out |
| Canonical release/runner repair | A current SFP release manifest/authority using the existing program/preparation model; runner actually scheduled outside accidental legacy coupling; exact current recipients/content/sender authorized; old unrelated producers stay contained |
| Identity/reply/capacity repair | One consistent identity reader and monitored reply route; actual transport selected; shared per-sender/program caps apply to initial and follow-up sends; ambiguity after dispatch never blindly retries |
| Certification | Disposable real writers and fake clock/transports demonstrate preparation → owned paused membership → scoped release → one dispatch → durable receipt; repeat cycle sends next correct step; opt-out/reply/bounce/pause cancel future work; concurrency cannot duplicate a send or overshoot cap |
| Production prelaunch proof | Served build and native schema verified; current eligible/held counts by business/address/vertical/county; no missing steps; real rendered previews; no prospective recipient sends yet |
| Controlled delivery proof, after explicit launch authorization | Operator-owned seed mailbox receives actual message; inspect authentication, links, footer and reply; canonical feedback stops subsequent work. Then release a bounded first recipient batch and verify real accepted/delivered/failed receipts |

The audit request itself is not authorization to send the seed or recipient batch. Preparing the code, content, tests and reviewable release manifest does not require asking the user to repeatedly approve investigation.

After initial delivery proof, the same approved program should replenish its qualified queue and progress normally within its cap; ordinary new eligible contacts should not require repeated manual enrollment. Increase volume only with actual transport capacity and delivery/reply/bounce/complaint measurements. Separate provider acceptance from delivery, and both from replies, statement uploads, booked appointments and converted merchants. Opens alone are not success evidence.

## 9. Existing protections to retain

The inspected code already provides useful pause checks at transport, canonical commercial classification, DBPR/suppression checks, current validation eligibility, lease-backed claims and contact-level reply fencing. `outbound-send-log.ts` deliberately does not automatically reclaim dispatching/failed attempts because provider outcomes may be ambiguous. Preserve this and supply evidence-backed settlement/recovery, rather than changing “unknown” to “sent” or repurchasing blindly.

`authorizeSequenceDispatch()` checks owned attempt, active membership/current step and absence of a canonical inbound event in the guarded transaction. This is useful **only if the actual SMTP/GHL reply reaches that canonical event stream**. That integration remains a delivery acceptance requirement.

## 10. Verified limits and unresolved evidence

- No customer or seed delivery occurred, so authentication alignment, actual inbox placement, actual reply ingestion and production bounce/complaint handling are not certified.
- Cold-email-health confirms prerequisites exist; it does not validate postal-address correctness, token behavior over HTTP POST, mailbox ownership or provider terms.
- No provider-side ZeroBounce balance or SMTP/GHL capacity/account terms were read from their authenticated dashboards.
- All live inventory readers were checked; no claim that hidden GHL-native campaigns or every public website claim received an editorial audit.
- No full app build, database migration delivery, native catalog comparison or full regression runner was executed here. Existing past certification claims are not relabelled as fresh results.
- No exact current SFP sendable-population query was available from the inspected aggregate screens. Produce that intersection in the continuation; do not substitute ready-held, valid, mapped, enrolled or frozen-cohort counts.

**Launch verdict: blocked by specific repairable execution and content gaps. The fastest useful next work is the scoped launch repair above, alongside local enrichment.**

## Appendix A — exact affected legacy upload CTAs

Pairs are `sequence:step-order (step ID)`. All 35 are email actions and use an Upload-labelled link to the old booking destination:

`80:1 (15900)`, `80:4 (15906)`, `77:1 (15875)`, `77:4 (15881)`, `76:3 (15870)`, `74:1 (15852)`, `74:4 (15856)`, `73:3 (15847)`, `71:1 (15830)`, `71:4 (15833)`, `70:3 (15825)`, `68:1 (15804)`, `68:4 (15807)`, `67:3 (15797)`, `65:1 (15778)`, `65:4 (15781)`, `64:3 (15772)`, `62:1 (15752)`, `62:4 (15757)`, `61:3 (15747)`, `59:1 (15728)`, `59:4 (15734)`, `58:3 (15723)`, `56:1 (15705)`, `56:4 (15711)`, `55:3 (15700)`, `54:4 (18993)`, `49:1 (18962)`, `49:5 (18966)`, `45:4 (18925)`, `42:1 (170)`, `36:4 (18916)`, `33:4 (138)`, `4:4 (18908)`, `4:5 (18909)`.

## Appendix B — inventory disposition

| Objects | Audit disposition |
| --- | --- |
| SFP sequences 1153–1157 / campaigns 82–86 | First launch scope; populate with corrected existing content using Section 6, then version and verify before release |
| W6 sequences 85–94 | Governance/lifecycle and content references; reuse the applicable parts, do not activate wholesale; 85 needs the broken URL/claim repair |
| Active legacy sequences 55–84 | 30 active entries; includes vertical prospecting, inbound, merchant ops and sales; exclude from SFP release. Correct copy/CTAs/fields and lifecycle mapping before any separate use |
| Active sequences 1148 and 1152 | Statement Chase / Win-Back; exclude from blanket release; require real statement/merchant lifecycle and reviewed copy |
| Sequences 1–54 | Paused older libraries; overlaps and assumptions documented above; not a bulk-launch alternative |
| Test sequences | 18 explicitly test-named sequences; preserve audit history and exclude from production launch selection |
| Campaigns 2–11 | Existing content library for reuse; prioritize 2, 6, 8 and 11 per Section 6. Correct math, claims, field language and secure-upload requests in selected launch content; keep source campaigns draft unless separately authorized for their own execution |
| Campaign 69 | Active concurrent-preview test campaign with one actual step despite three declared; exclude from launch |
| Campaigns 77/79 | Empty mismatch-gate test shells; exclude |
| Saved email templates 1/3/4/5/6/8 | Lifecycle-specific library; proposal needs real deal facts; review link is unresolved; nurture assumptions cannot be applied to cold inventory |
| Saved SMS templates 2/7 | Not part of initial cold-email launch |

Additional count mismatches: seq 1 declares three steps but returns zero; seqs 511, 235–246 declare zero but return one or two. These and the test clutter help explain misleading completion/step counters. Do not delete history as part of launch repair; make actual content and launch disposition clear.

## Appendix C — reproducible evidence and source anchors

Pinned source root: https://github.com/scottpstevenson/Liberty-Bancard-Website-and-CRM/tree/16cb70ebb94f2d7dc02cb7b993be77a382b88b94

| Source | Review anchors |
| --- | --- |
| `server/services/cro03/sfp-campaign-packages.ts` | `applyPackageConvergenceV2`, `computeLivePackageContentHash`, `verifyPackageConvergenceV2` |
| `server/services/cr06-promotional-lifecycle-decision.ts` | `decideCr06PromotionalLifecycle`, default promotional classification |
| `server/services/queue-manager.ts` | SEQUENCES handler, `LEGACY_OUTREACH_ENABLED`, `runSequencesTick` |
| `server/services/sequence-worker.ts` | claim lifecycle decision; empty steps; relative delays; interpolate; `estimatedSavings`; signature; SMTP/GHL routing; cap reservation |
| `server/services/campaign-engine.ts` | both personalization functions and their fallback; contact/prospect send paths |
| `server/services/sender-policy.ts` | cold_outreach From/Reply-To |
| `server/services/can-spam-footer.ts` | current prerequisites and HTML/plain-text rendering |
| `server/services/smtp-email.ts` | pause epoch, headers and actual sendMail call |
| `server/services/ghl.ts` | rendering, emailReplyTo, inbound reply/suppression processing |
| `server/services/outbound-send-log.ts` | leased claim, dispatch authorization and ambiguous outcome handling |
| `server/services/communication-events.ts` | canonical reply decision |
| `server/routes/public.ts` | signed GET unsubscribe consent command |
| `server/routes/activation.ts` | incompatible active-identity filters and outbound settings |
| `server/routes/admin.ts` | identity, deliverability and cold-email-health GET readers |
| `server/routes/campaigns.ts` | list/steps readers; enrollment update/resume restrictions |
| `client/src/App.tsx` | actual `/upload-statement` route |

Read-only reproduction: compare parent `totalSteps` to each steps reader; load W6 85 as a positive endpoint control; open `/upload`; compare activation/readiness/identity settings; examine exact current renderers. Do **not** follow an actual recipient's unsubscribe token or invoke POST send/enroll/run/activate during a read-only audit.

Local extracted-function check: `intermediate/outreach-launch-audit/check-rendering.mjs`, 12 assertions passed. It confirms supported sequence replacement, unsupported booking-token rejection, unescaped HTML value behavior, unresolved campaign camelCase versus working snake_case with AI disabled, two arithmetic facts, cumulative delay arithmetic, and public GET/no-public-POST route declarations. It does not exercise application dependencies or make production writes.
