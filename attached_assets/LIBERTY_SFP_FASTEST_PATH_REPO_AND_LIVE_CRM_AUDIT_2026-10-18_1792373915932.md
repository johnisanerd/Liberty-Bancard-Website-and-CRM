# Liberty Bancard — fastest path to South Florida outreach
## Repository and live CRM audit — October 18, 2026

**Recommendation:** Finish a launchable subset of the recipients already prepared, while prioritizing South Florida businesses that already have contact or website evidence. Run these in parallel. Do not make the first outreach wait for the nationwide contact backlog, the full Sunbiz corpus, or a new dashboard.

### Evidence and scope

- Repository audited: `scottpstevenson/Liberty-Bancard-Website-and-CRM`, main `16cb70ebb94f2d7dc02cb7b993be77a382b88b94` (October 19, 00:25 UTC / October 18, 8:25 p.m. Eastern).
- Authenticated live CRM inspected approximately **8:34–8:42 p.m. Eastern, October 18**. These are direct observations, not just the pasted Replit report.
- Inspected Canonical Enrichment, Lead Ops businesses, South Florida Prospecting, Enrichment Program Health, Provider Results, Outreach sequences, Go-Live Controls, and Ready for Outreach. Read existing linking-status and staged-email-preview GET responses in the authenticated browser.
- The program-health screen reported API and worker revision `59ea7da584eb…`. A GitHub comparison from that revision to audited main returned **no changed files**. Publication metadata and an observed worker revision are distinguished from a full deployed-flow certification.
- No direct production SQL connection was used. No application/production records, provider controls, budgets, enrollments, or sending settings were changed. No enrichment, validation, replay, provider purchase, test send, or campaign launch was triggered.
- Existing read-only CRM pages perform their own reads/probes. Sign-in was completed through secure browser authentication. No credentials are included here.
- The SFP funnel-preview navigation did not return a usable observation. No zero, current eligible count, or ROI total was inferred from it.
- Ten local assertions executed the exact CR-06 lifecycle-decision source. No database, network, or provider was involved. A production build, full test roster, PostgreSQL certifications and delivery test were **not** run.

## 1. What exists now

| Measure | Direct live observation | Interpretation |
|---|---:|---|
| Active production contacts | 158,442 | Global inventory; not a South Florida recipient count |
| Current verified contact–business links | 6,102 | Linking-status population; no unverified legacy projections reported |
| Businesses with those verified links | 4,111 | Distinct businesses, not contacts |
| Unresolved contacts | 152,340 | Global population; need not all resolve before launch |
| Verified links committed in the last 24 hours | 697 | Actual link commits, unlike cumulative scan/hold counts |
| Canonical businesses | 93,540 | Global canonical inventory |
| Current effective mapped verticals | 5,817 | Approximately 6.2%; not all in South Florida |
| Unresolved effective verticals | 73,898 | Includes missing/conflicting/unresolved states |
| Excluded effective verticals | 13,825 | Do not treat these as classification work that must become target |
| Contacts with stored email status “valid” | 943 | Status count only; not independently checked for current receipt/policy eligibility |
| Canonical preparation records “ready_held” | 562 | Persisted states; require current requalification and owned-membership reconciliation |
| Canonical preparation records “pending_validation” | 730 | Not 730 immediately dispatchable validation jobs |
| Canonical preparation rejected / exception | 577 / 2 | Not sendable |
| Historical SFP ready-held records | 72 | Separate legacy population; do not add as another certified ready pool |
| Preparation-linked validation intents pending / processing | 59 / 12 | Status-reader observation; oldest pending October 13 |
| Staged business-email rows | 24,658 | Exact preview definition; different from all staged candidate types |
| Staged emails eligible for evaluation now | 3,497 across 2,160 businesses | Global database-side selection; address/domain/suppression checks still follow |

The linking response timestamp was **00:40:19–21 UTC October 19 / 8:40 p.m. Eastern October 18**. Canonical inventory/preparation figures were observed at 8:34 p.m. They are separate statements and timestamps, not a transactionally frozen census.

The linking program’s 357,181 scans and 355,857 holds are repeated-pass counters, not distinct people. Its 1,324 committed count is a particular program’s history, not the total 6,102 verified population.

The disposition report also contains older per-contact decisions. For example it reported 5,653 contacts under “existing verified assignment preserved” while the current population was 6,102. Do not substitute stored disposition history for the current relationship join.

## 2. The shortest route to first outreach

### First: turn existing preparation into a usable launch population

Start with the **562 recorded canonical ready-held preparations**, then the **730 pending-validation preparations**. These have already traversed more of the pipeline than raw registry businesses or unassigned nationwide contacts.

For each current ready-held item, reconcile:

1. Active production contact, normalized address, current verified business relationship.
2. Business geography in Broward, Miami-Dade or Palm Beach and a current accepted effective vertical.
3. Exactly one supported current program/sequence binding and usable content.
4. Fresh business/address validation receipt, suppression state and current channel qualification.
5. Its owned paused sequence membership and actual held reason.
6. Sending identity, reply handling, per-day capacity and the supported release path.

Keep one primary recipient per business first; retain useful alternatives for replacement. This maximizes business coverage per validation and send. The existing up-to-three allowance need not be removed.

**The exact sendable subset is not yet established.** “562 ready-held” is a practical starting population, not authorization to send 562 messages.

### In parallel: bulk finish the local evidence-rich inventory

Prioritize eligible South Florida businesses in this order:

| Priority | Work | Why it is close to usable recipients |
|---|---|---|
| 1 | Reuse current valid receipts for already linked, mapped, locally eligible contacts | No repeated discovery or validation purchase |
| 2 | Finish current selected pending validations and reconcile stale/ambiguous work | Known recipients already have durable preparation |
| 3 | Materialize retained first-party/Outscraper emails for local businesses | Business identity and mailbox evidence already exist |
| 4 | Classify local businesses already holding usable mailboxes or linked contacts, using retained category/site evidence | Resolves the vertical gate on existing supply |
| 5 | Crawl already-known local official sites for missing contact channels | No paid website-discovery purchase |
| 6 | Resolve local CRM/GHL/import affiliations and supported missing business records | Uses retained facts before buying new identity evidence |
| 7 | Use Serper for the remaining specific website/category gaps | Paid discovery follows useful local evidence, memory and measured yield |

These are branches, not a mandatory rigid chain. Linking must remain independent of vertical and ZeroBounce. A business without a website can still progress from a supported listing category and a retained email. A valid contact with no business relationship needs affiliation work, not another ZeroBounce call.

Keep the broader #2091 nationwide work progressing, but give South Florida evidence-rich cases priority rather than waiting for all 152,340 unresolved contacts.

## 3. A launch feature is still missing; enrichment alone cannot solve it

**Confirmed in source:** promotional lifecycle execution is hard-disabled.

- [CR-06 lifecycle authority](https://github.com/scottpstevenson/Liberty-Bancard-Website-and-CRM/blob/16cb70ebb94f2d7dc02cb7b993be77a382b88b94/server/services/cr06-promotional-lifecycle-decision.ts#L34-L58) returns `allowed:false` and `CR06_PROMOTIONAL_EXECUTION_DISABLED` for promotional execution.
- [Sequence worker](https://github.com/scottpstevenson/Liberty-Bancard-Website-and-CRM/blob/16cb70ebb94f2d7dc02cb7b993be77a382b88b94/server/services/sequence-worker.ts#L383-L407) applies this before claiming promotional steps.
- [Premium campaign module](https://github.com/scottpstevenson/Liberty-Bancard-Website-and-CRM/blob/16cb70ebb94f2d7dc02cb7b993be77a382b88b94/server/services/cr06-premium-campaigns.ts#L12) declares `CR06_DISPATCH_AVAILABLE=false`.
- [Enrollment API](https://github.com/scottpstevenson/Liberty-Bancard-Website-and-CRM/blob/16cb70ebb94f2d7dc02cb7b993be77a382b88b94/server/routes/campaigns.ts#L1408-L1426) disallows client updates to enrollment status/metadata.
- [Pause API](https://github.com/scottpstevenson/Liberty-Bancard-Website-and-CRM/blob/16cb70ebb94f2d7dc02cb7b993be77a382b88b94/server/routes/campaigns.ts#L1532-L1552) expressly refuses HTTP resume.

The local ten-check execution confirmed promotional sequence enrollment/claim/transport, bulk enrollment and campaign queue/transport are blocked; explicitly transactional/human-response purposes remain separate.

**Consequently, unpausing outbound or activating a sequence is insufficient.** A supported release authority for current canonical SFP preparations must be implemented or identified and proven before a launch is promised.

This should be a narrowly scoped launch-delivery outcome, not removal of every guard or a global enablement of old producers. It must release only current owned SFP memberships, preserve opt-outs/bounces/identity protections, enforce actual sender capacity, and prevent the many unrelated legacy enrollments from becoming active accidentally. Reuse existing paused memberships rather than duplicate enrollments.

The CRM displayed **all five SFP v2 sequences paused**, five steps each, and zero active recipients in each. Their total “enrolled” badges are historical membership counts, not ready/sendable populations.

## 4. The operating screens still mix old and current paths

### “Ready for Outreach” retains a cohort requirement at its front door

[Route](https://github.com/scottpstevenson/Liberty-Bancard-Website-and-CRM/blob/16cb70ebb94f2d7dc02cb7b993be77a382b88b94/server/routes/outreach-queue.ts#L228-L255) requires `cohortRunId` before calling the authority.

But [the authority’s email branch](https://github.com/scottpstevenson/Liberty-Bancard-Website-and-CRM/blob/16cb70ebb94f2d7dc02cb7b993be77a382b88b94/server/services/cr04-cohort-ready-authority.ts#L704-L722) already delegates to canonical preparation without requiring a cohort.

The queue projection also excludes contacts with any active/paused membership through its qualification reader. It is therefore not the canonical ready-held inventory. Its vertical filter uses `contacts.vertical`, unlike the current effective-business reader.

**Repair:** make the email route and existing workspace use current canonical preparation and binding semantics. Add useful current recipient rows/reasons to the existing workspace; do not create another general dashboard or demand a new frozen cohort.

### The live “342 in scope” counter is a legacy cohort count

The health page showed 342 scoped versus 26,220 outside scope. [Its query](https://github.com/scottpstevenson/Liberty-Bancard-Website-and-CRM/blob/16cb70ebb94f2d7dc02cb7b993be77a382b88b94/server/routes/lead-ops.ts#L3379-L3425) actually checks frozen `sfp_cohort_members`.

This does **not** establish that only 342 staged emails are eligible under today’s South Florida program. It must not be used to size or gate the canonical drain.

The Provider Results ZeroBounce section likewise showed 35 stored-valid emails and an October 3 latest record from historical SFP eligibility. It is not the live selected-contact validation ledger. The canonical page’s 943 status-valid contacts and current pending work illustrate the different reader populations.

## 5. The faster email drain has now landed, but its priority is global

[Queue integration](https://github.com/scottpstevenson/Liberty-Bancard-Website-and-CRM/blob/16cb70ebb94f2d7dc02cb7b993be77a382b88b94/server/services/queue-manager.ts#L2767-L2778) now runs pages of 100, bounded by 2,000 examined candidates or five minutes. The old fixed 25/half-hour diagnosis is superseded for this code.

The [selector](https://github.com/scottpstevenson/Liberty-Bancard-Website-and-CRM/blob/16cb70ebb94f2d7dc02cb7b993be77a382b88b94/server/services/free-discovery/staged-email-materialization.ts#L118-L174) orders mapped verticals first, then business ID and mailbox rank. It has no South Florida priority. It counts usable existing contacts, skips quarantined/DBPR-lineage businesses and retries held outcomes after 24 hours.

**Next change:** give locally eligible evidence-rich businesses priority without prohibiting legitimate global association work. Separate never-evaluated work from due unchanged holds, retaining fairness. Measure linked/usable/prepared outcomes per minute, not just candidates inspected.

The 3,497-candidate preview is database-side eligibility only. It does not yet check every decrypted address’s attribution and suppression inside the write transaction. It is not a forecast of 3,497 new contacts.

Investigate the heavy third-party-domain holds with representative retained pages before relaxing rules. Some can be genuine site-template/vendor contamination; others may involve supported aliases/redirects. The answer is evidence-aware attribution, not accepting every scraped address.

## 6. “Highest ROI” selection is not implemented in the ordinary discovery selector

[Current ordinary selection](https://github.com/scottpstevenson/Liberty-Bancard-Website-and-CRM/blob/16cb70ebb94f2d7dc02cb7b993be77a382b88b94/server/services/cro03/sfp-discovery-scope.ts#L104-L163) explicitly sets `0 AS roi_score`, sorts by last stage activity then business ID, and resolves geography while traversing candidates. Historical cohort ROI tooling is a different path.

Do not claim the current recurring selector buys the highest-ROI work.

Use a practical priority based on **distance to a usable recipient and incremental cost**: current ready-held, current selected validation, retained local mailbox lacking vertical, local classified business lacking mailbox, and finally paid missing-site/category discovery. Within those groups use supported merchant fit, current operating evidence, source quality and measured conversion/yield; do not invent processing volume or profitability from a business name.

For current local targets with known websites, skip a paid website search. Reuse accepted listing categories and completed provider receipts. Use OpenAI when real retained business text needs interpretation; avoid repeatedly paying to classify name-only shells.

Keep Serper enabled with its lookup memory. The earlier proposed 500-credit registry measurement is a separate one-time measurement budget, not a recurring daily enrichment budget or a prerequisite for the free/local repairs. No price-per-request factor was verified in this audit.

## 7. Existing source inventory is more useful than a full registry sweep

Sunbiz contains valuable identity/source facts, but 1.9 million filings are not 1.9 million operating local merchant prospects with reachable inboxes. Do not make classifying/materializing all of them the near-term outreach goal.

The live backfill reported its South Florida pass processed 93,776 records and had approximately zero remaining eligible there; it was now traversing the remaining universe. This is source-processing progress, not new current verticals or recipients.

Focus first on the five retained workbooks and other imports **where current geography fits**, existing linked local contacts, first-party staged mailboxes and CRM/GHL company facts. Preserve original provenance. A missing Sunbiz match must not itself prevent an ordinary supported CRM company association.

The current materializer reads retained `businessEvidence` and original provider rows; its independent corroboration requirements can leave contacts whose only retained facts are on the contact itself unresolved. The live report recorded 141,685 “legacy contact fields only” dispositions and 964 missing retained GHL-organization-evidence dispositions. Those are global historical dispositions, not proof that the people have no company fields or all require a paid provider.

#2091 should recover source information and supported missing CRM businesses, particularly for local contacts, without falsely labelling a CRM-sourced business independently registry-verified.

Likewise, business `main_email` values need contact/receipt reconciliation. This audit did not establish how many unique South Florida business emails lack a linked contact. Do not assume all roughly 5,000 previously reported business emails are new recipients, and do not validate them again blindly.

## 8. Sending capacity and readiness need reconciliation

The live Identity Wizard showed one identity, warmup “warm”, health 100 and a displayed full daily schedule of **50 messages/day**. These are application observations, not an external deliverability certification.

The Readiness tab simultaneously reported **no active identity with capacity**, 0/39 workflow IDs and ORCHESTRATOR_ENABLED off.

There is a source-level reason the identity displays can disagree:

- the operator status endpoint considers an identity active when `isActive !== false && status !== "paused"`;
- readiness requires `status === "active" && isActive !== false`.

Reconcile the actual identity’s state and effective runtime limits before activation. Do not assume the wizard’s “active” badge is sufficient.

The sequence architecture explicitly uses Replit scheduling with GHL delivery/upsert. `enrollContactInGhlWorkflow()` does not trigger GHL’s outbound workflows. Therefore “Missing GHL ID” and “configure five workflow IDs” must not automatically become requirements for these locally scheduled SFP sequences. Verify the actual email transport, GHL contact mapping, sender/reply route, unsubscribe and reply-stop handling.

Do not simply enable the whole orchestrator to turn every unrelated program on. Determine the exact canonical SFP execution dependencies.

At a real 50-message/day effective capacity, 562 recipients already represent more than eleven days of first touches alone, before follow-ups. More sender capacity may eventually matter, but first establish an actually usable release path and the real cap. More enrichment cannot by itself increase send capacity.

## 9. Recommended delivery order with the least additional work

**Keep two accountable outcomes, not a task for every symptom.**

### Outcome A — launch the first current SFP recipients

Use the existing launch/outreach continuation, or one focused launch task if none exists. It must:

- enumerate/requalify the current ready-held population and its owned memberships;
- resolve the email-route cohort mismatch and expose current rows/reasons;
- implement or prove supported scoped activation through CR-06 and the sequence worker;
- reconcile the sender state/capacity and real transport dependencies;
- prove one first step, reply-stop, unsubscribe, retry/idempotency and follow-up scheduling using controlled delivery verification before a real prospect launch;
- leave final real sending disabled until explicit operator release.

Do not wait for #2091’s whole population or #2090’s registry measurement.

### Outcome B — keep adding local recipients automatically

Coordinate existing #2087/#2089 for evidence, accepted verticals, staged-email materialization, preparation and validation. Use #2091 for source-backed affiliation recovery and missing businesses. Keep #2090 for paid website/category gaps and lookup accounting.

Add South Florida/near-ready priority and end-to-end stage accounting to existing workers. Classify the businesses that already have mailboxes before spending on empty registry shells. Resolve stale selected validations using retained receipts and dispatch evidence; do not replay ambiguous provider work blindly.

One existing Canonical Enrichment screen can show the current population and optional “process priority backlog” control. That screen must reflect connected execution. Its construction must not delay Outcome A or become another manual job-running workflow.

## 10. Acceptance: useful output, not more counters

The next implementation should report, by the three counties and five current verticals:

- distinct businesses with at least one current usable recipient;
- newly linked contacts and source facts used;
- newly accepted/current effective verticals;
- newly selected pending validations, completed fresh receipts and exact retry/hold reasons;
- current canonical ready-held recipients and businesses, with correct owned paused memberships;
- recipients actually released and provider-accepted messages once a real launch is authorized;
- replies, opt-outs/bounces, follow-up scheduling and delivery costs/credits where actually known.

A scan, a successful queue tick, a provisional classification row, a historical “enrolled” badge and a local consumed-unit counter are not substitutes for those outcomes.

**Immediate business decision:** use the existing ready-held population as the first launch inventory while growing the local evidence-rich population in parallel. Finish the missing launch boundary instead of waiting for the whole database to become enriched.

### Audit limits

Exact current sendable-recipient and distinct-business counts within the 562 preparations were not obtainable from the inspected aggregate screens. No direct SQL or current full SFP funnel census was executed. ZeroBounce’s vendor balance/invoice and Serper’s account balance were not inspected. These remain explicit measurement requirements, not assumed blockers requiring user operation.

No guarantees are made that every prepared item is currently qualified, every staged email is attributable, every unmatched contact is a business prospect, or every unmapped registry entity belongs to a target vertical.

