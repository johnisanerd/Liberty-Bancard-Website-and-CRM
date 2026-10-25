# GHL native-safety review: approval package (prepared for the owner; not an approval)

Status: **prepared, not approved.** The review state remains `unverified`. Nothing in this repository, and no agent, may
approve it. Approval is the owner's action in the admin Activation Panel after the inventories below are refreshed.

Identity/profile writes, permission/suppression writes, tag writes and workflow enrollment are four separate things.
This package covers the first three. Workflow enrollment stays off: no operation below enrolls a contact, adds a
workflow id, or sends a message.

Facts below come from the code that builds the payloads (`server/services/ghl.ts`, `server/services/ghl-sync.ts`) and from
dated observations. Items marked **to record at review time** cannot be known from the repository.

## 1. Operations the projection can perform (in this order, one component per write)

| # | Component | Method and template | Capability | Top-level keys sent | Notes |
|---|---|---|---|---|---|
| 1 | identity + profile + required suppression | `POST /contacts` (create) or `PUT /contacts/:contactId` (update) | `crm_write`; `permission_write` when the body carries a suppression key | `locationId` (create only), `firstName`, `lastName`, `email`, `phone`, `companyName`, optional `customFields` | **No `tags`.** A true `lb_do_not_contact` / `lb_do_not_autocontact` is in this first write. |
| 2 | permissions | `PUT /contacts/:contactId` | `permission_write` (needs `permissionsEnabled`) | `customFields` only | All installed permission keys (section 3). |
| 3a | parent/pipeline fields | `PUT /contacts/:contactId` | `crm_write` | `customFields` only (`lb_do_not_sdr`, `lb_location_of`) | Always after 1 and 2. Never carries `tags`. |
| 3b | owned-tag add | `POST /contacts/:contactId/tags` | `crm_write` | `tags` (only `LB-ACTIVE-PIPELINE` and/or `lb_parent_account`) | Only when the CRM wants an owned tag the contact does not yet carry. |
| 3c | owned-tag remove | `DELETE /contacts/:contactId/tags` | `crm_write` | `tags` (only `LB-ACTIVE-PIPELINE` and/or `lb_parent_account`) | Only when the CRM no longer wants an owned tag it last applied. |

The review payload for tags: operations `POST` and `DELETE` on `/contacts/:contactId/tags`, field `tags`, allow-list
`LB-ACTIVE-PIPELINE`, `lb_parent_account`. If these two operations are not in the approved review, the tag component is
reported as held (`tags:operation_not_reviewed`); identity, suppression and permission storage are not blocked by it.

Read-only calls (never mutate): `GET /locations/:id/customFields`, `GET /workflows/`,
`GET /contacts/search/duplicate?locationId=&email=|number=`, `GET /contacts/:id` (exact-record proof, section 2).

Excluded: opportunities, notes, tasks, calendars, conversations/messages, workflow enrollment, tag creation,
custom-field creation, deletes.

## 2. Identity rules enforced before and during every request
- Lookup before create. The lookup answer must be a recognized shape (`contacts` array or `contact`); any other body is
  `GHL_LOOKUP_RESPONSE_UNSUPPORTED`, never "absent", and nothing is created or linked.
- An email lookup identifies a record only when the returned record states the same email. A record with no email or a
  different email, or several records, is held (`GHL_IDENTITY_AMBIGUOUS:<reason>`); no write.
- A phone-only contact is created only when the provider confirms the phone is absent. A phone-only match, before or after
  an ambiguous create, is held for review, never linked. Recency of a remote record is not identity proof.
- A duplicate-contact 400 only names a candidate. The code reads that exact record (`GET /contacts/:id`); an
  email-bearing contact links only when the remote record states the same email (case-insensitive) and no other local
  contact owns the remote id (a failed ownership lookup fails closed). A phone-only contact is never linked this way.
- Known identity: once a contact holds a `ghlContactId`, that local link is the authority for updates. `PUT` writes the
  profile identity fields to that id without re-reading the remote record. Linking happens only through the rules above.
- A required suppression whose provider field is not installed defers the whole projection before any mutation.
- Other optional fields not installed in GHL are recorded as held (visible per contact) and omitted; fields are never created.
- Each custom field is sent by provider id and must match the reviewed id/key pair.
- Final fence before every request, including transport retries: claim token, unexpired lease, claimed generation (a newer
  committed edit refuses further mutations for that claim), runtime selection/lease/job ownership, eligibility including
  export scope (section 7); a durable operation row is appended first.

## 3. Custom fields
Installed contact fields, observed 2026-10-24 in location `BbcWy2xmyg4izLjlFfLQ` (provider key, provider id, provider type):

| Provider key | Provider id | Provider type | Emitted by the contact projection |
|---|---|---|---|
| `contact.lb_do_not_sdr` | `Rfo6frTXZrzZtbUKsNN1` | TEXT | yes (pipeline marker) |
| `contact.lb_pain_points` | `CpXFAsahrrp9J837HHI1` | TEXT | yes (profile) |
| `contact.lb_promo_code` | `86igW42wnYpLVGMWADrj` | TEXT | yes (profile) |
| `contact.lb_lead_source` | `Rog35nsPLTFPa4A1UOJD` | TEXT | yes (profile) |
| `contact.lb_consent_sms` | `k3gqyGYfAgTalYoYPa8P` | TEXT | yes (permissions, when known) |
| `contact.lb_consent_email` | `0rhXcXVAQCBxrFtPU5uY` | TEXT | yes (permissions, when known) |
| `contact.lead_score` | `kyvrvgpTmsBitm6FprMr` | NUMERICAL | no |
| `contact.contact_role` | `tUJVLBfNKPmkygKuxIRQ` | SINGLE_OPTIONS (Owner, Signer, Day-to-day) | no |
| `contact.external_contact_id` | `fnfj8vufduU1sjB0zfmA` | TEXT | no |

What the adapter, the Activation Panel and the inventory hash actually bind: each field's **provider id and key**.
They do **not** carry or verify the provider's field *type*. The types above are owner-supplied observations recorded
here as evidence; changing a field's type in GHL without changing its id or key would not change the inventory hash.
The nine-field id/key revision recorded earlier is `060ff897f71905e6e02d8e0c940800971107856d9a1c0c735bac9cbcf7bb62fb`.

Keys the code can emit, by component:

| Component | Keys (emitted when the condition holds) |
|---|---|
| Suppression (first write, only when true) | `lb_do_not_contact`, `lb_do_not_autocontact` |
| Permissions (every run) | `lb_do_not_contact`, `lb_do_not_autocontact`, `lb_lifecycle_stage`, `lb_channel_permissions_updated_at`; when known: `lb_consent_sms`, `lb_consent_email`, `lb_consent_tier`; when the contactability matrix resolves: `lb_can_email`, `lb_can_manual_call`, `lb_can_sms`, `lb_can_ai_voice`, `lb_can_ringless_vm`, `lb_channel_permissions` (JSON of the five channels), and `lb_channel_block_reason` when blocked |
| Profile (when the contact has a value) | `vertical`, `lb_vertical`, `monthly_volume`, `lb_monthly_volume`, `offer_path`, `lb_preferred_program`, `lb_offer_route`, `current_provider`, `lb_current_processor`, `lb_offer_confidence`, `lb_recommended_action`, `lb_offer_reasoning`, `lb_processor_detected`, `lb_pain_points`, `lb_interested_0_percent`, `lb_terminal_need`, `lb_utm_source`, `lb_utm_medium`, `lb_utm_campaign`, `lb_promo_code`, `lb_referral_source`, `lb_partner_code`, `lb_lead_source` |
| Tags component | `lb_do_not_sdr` (only when the active-pipeline tag changes), `lb_location_of` (parent name; a missing field is reported as a held component) |

Not installed (observed 2026-10-24) and therefore held, never created: every permission key except `lb_consent_*`, the
two suppression keys, `lb_location_of`, and every profile key except `lb_promo_code`, `lb_pain_points`, `lb_lead_source`.
**Owner decision:** `lb_do_not_contact` / `lb_do_not_autocontact` must be installed before any contact that is
suppressed locally can be exported; until then those contacts defer before any write. Installing them is not an
activation approval, and installing them does not by itself make the first write safe — the first-write ordering above
does. Definitions, accepted values (`"true"` / `"false"`), source mapping (local `do_not_contact` / `do_not_auto_contact`)
and the resulting payload are as written here; install only after this package is accepted.

### Exact install specification for the two suppression fields (not installed; do not create from the repository)
| Key | Display name | Type | Values | Local source | Payload form |
|---|---|---|---|---|---|
| `contact.lb_do_not_contact` | LB Do Not Contact | TEXT | lowercase `"true"` or `"false"` | `contacts.do_not_contact` | `{"id":"<provider id>","field_value":"true"}` |
| `contact.lb_do_not_autocontact` | LB Do Not Auto Contact | TEXT | lowercase `"true"` or `"false"` | `contacts.do_not_auto_contact` | `{"id":"<provider id>","field_value":"true"}` |

A contact that is suppressed locally carries `"true"` in the **first** identity write (create or update). After creation:
refresh the inventory, record the two new provider ids, and re-run the review payload with them in the approved
field-id list (the review binds to the refreshed inventory hash). Native workflows do not reference either field or any
`lb_can_*` channel field. Creating the fields therefore does **not** make native sending honor CRM suppression: the
native gates are native Email DND and the tags `outreach.opted-out`, `outreach.blacklisted`, `outreach.bounced`,
`opted-out`, `blacklisted`, `bounced`, `needs-enrichment`, which are GHL-owned and preserved by this projection.

## 4. Tags (exact allow-list)
The CRM owns exactly two tags on a GHL contact: `LB-ACTIVE-PIPELINE` (active-deal state) and `lb_parent_account`
(parent-account flag). Every other tag on the remote contact (`outreach.paused`, `outreach.replied`,
`outbound-merchant-enrolled`, opt-out/bounce/source tags and anything else) is owned by GHL and its workflows and is
**never read for replacement, sent, or removed**.

The projection sends only owned-tag **deltas** through the add-tags (`POST /contacts/:id/tags`) and remove-tags
(`DELETE /contacts/:id/tags`) endpoints, which cannot touch any other tag, and only when the CRM's last known state of an
owned tag differs from what it wants. No update carries a `tags` array. The local copy of an owned tag changes only after
the provider accepted the delta; a failed write is retried idempotently. A provider rejection (400/403/404/422) or an
unreviewed operation is a held component (`tags:provider_rejected_<status>` / `tags:operation_not_reviewed`): reported,
not retried forever, and it never blocks identity or permission storage. Transient failures stay retryable.

Neither owned tag matches any inspected native workflow trigger (section 5).

## 5. Native workflow evidence (inspected 2026-10-24 from the workflow application's actual definitions)
**14 workflows, 6 published, 8 draft** (draft triggers were inactive when inspected). Every Sales Meeting appointment
filter uses calendar `YFiIy7oIOUXN2qZZPnOr`. No workflow triggers on generic contact create, profile change, custom-field
change, or on the two owned tags; none reads `lb_do_not_contact`, `lb_do_not_autocontact` or `lb_can_*`.

| Workflow ID | Name | Status | Actual trigger/filter | Configured actions / messaging | Effect of the proposed contact projection |
|---|---|---|---|---|---|
| `8d572880-6db5-4931-8b18-087af46cec33` | Liberty — Agents — Recruit Nurture | draft | Tag added: `mktg.agent-iso` (inactive) | Five email nodes: residuals, rep spotlight, portfolio buyout, call CTA, last call; waits to days 7/14/21/30; appointment goal. | No while draft. Neither owned projection tag matches this trigger. |
| `25b90839-ec70-4051-bf4e-8a27cdde54bb` | Liberty — Leads — Calculator Abandonment | draft | Tag added: `mktg.lead.calculator` (inactive) | Two statement-upload nudge email nodes and minute-based waits. | No while draft; matching marketing tag is outside projection scope. |
| `8222ea04-fad5-433b-89bb-32834648b3f2` | Liberty — Leads — Intake & Response | published | Customer booked appointment; contact-only; Sales Meeting calendar | Adds `src-inbound` / `speed-to-lead-fired`; assigned-owner branch creates task and internal notification; conditionally sends one inquiry acknowledgement; unassigned branch adds `needs-owner-review`. | No direct trigger from contact create/profile/permission or the two owned tags. A real booking or explicit workflow enrollment can enter it. |
| `458caed6-6e40-4d1b-8453-511d1accbc13` | Liberty — Meetings — Cancellation Cleanup | published | Appointment status invalid, cancelled, or showed; normal event; contact-only; Sales Meeting | Removes contact from No-Show Follow-Up (`336b720f-77af-4e3c-8d32-1570c0859916`). No message node. | No direct trigger from contact projection. Appointment lifecycle triggers it. |
| `d21d0367-d626-41ae-ab43-3999cd0f7bca` | Liberty — Meetings — Confirmation & Reminders | published | Appointment confirmed; normal event; contact-only; Sales Meeting | Removes No-Show Follow-Up; owner task/review tag; three conditional emails: immediate confirmation, 24-hour reminder, 1-hour reminder. | No direct trigger from contact projection. Booking/status event or explicit enrollment can send. |
| `336b720f-77af-4e3c-8d32-1570c0859916` | Liberty — Meetings — No-Show Follow-Up | published | Appointment no-show; normal event; contact-only; Sales Meeting | Wait four days, conditionally email; wait six more days, conditionally email again. | No direct trigger from contact projection. No-show event or explicit enrollment can enter it. |
| `457b5bb0-5c1e-4fe3-a5fa-9cbbc7e10a0b` | Liberty — Merchants — Contract Expiry Win-Back | draft | Custom-date reminder, 60 days before date (inactive) | Three renewal email nodes; waits 30 then 16 days; statement-review goal. | No while draft. No date-field mutation is proposed. |
| `40cd3463-febf-4e50-8603-115e8c89a562` | Liberty — Merchants — Lifecycle Review | draft | Pipeline-stage change: Merchant Sales `ETo0qSlXuF1oV9RPR2Oq`, open, stage `2d3c6940-5f50-4e3c-aa36-856b97bc09b5` (inactive) | Three merchant-service tasks at days 3/30/90; unassigned owner review tag; no email/SMS/call node. | No while draft; opportunities/stages excluded from projection approval. |
| `43d0ae09-1fd6-4989-8dd3-84ad252a3c2e` | Liberty — Merchants — Savings Review Request | draft | Tag added: `mktg.savings.proof-delivered` (inactive) | Two review-request/reminder email nodes; adds `mktg.review.asked`; seven-day wait; review-published goal. | No while draft; matching marketing tag is outside projection scope. |
| `667a50e4-39eb-42db-8ff9-809dba28bcd4` | Liberty — Merchants — Statement Review Follow-Up | draft | Tag added: `mktg.lead.statement-review` (inactive) | Two rate-education email nodes and a three-minute wait. | No while draft; matching marketing tag is outside projection scope. |
| `73837dce-dfe5-4081-a02d-a4bc92a18f2e` | Liberty — Merchants — Welcome | draft | Tag added: `mktg.customer` (inactive) | Two onboarding/welcome email nodes. | No while draft; matching customer tag is outside projection scope. |
| `02cbb528-c425-47cd-a5b8-b8ee71951048` | Liberty — Outreach — Merchant Sequence | draft | Tag added: `outbound-merchant-enrolled` (inactive) | Six configured email nodes and branch/wait logic; removes enrollment tag. Not every configured node is thereby certified reachable or launch-ready. | No while draft; never add this enrollment tag through profile sync. |
| `d86d18fc-0c8e-4967-bec9-842047d332e7` | Liberty — Outreach — Stop When Paused | published | Tag added: `outreach.paused` | Removes only Merchant Sequence (`02cbb528-c425-47cd-a5b8-b8ee71951048`). No customer message node. | The two owned tags do not trigger it. Removing/replacing native tags can still damage its state. This is not a global native pause. |
| `49796144-fb74-4247-90b3-ecd08f813a04` | Liberty — Outreach — Stop on Reply | published | Customer Replied, no trigger filters | Adds `outreach.replied`; removes Merchant Sequence and No-Show Follow-Up; removes `outbound-merchant-enrolled`; internal notification. | No direct trigger from contact projection. A reply triggers it. Does not remove every meeting workflow. |

Inspected versions, provider updated times and definition hashes (SHA-256 over canonical JSON of the inspected
definition; owner-supplied evidence, not re-verified per request):

| Workflow ID | Version | Provider updated time (UTC) | Inspected definition SHA-256 |
|---|---:|---|---|
| `8d572880-6db5-4931-8b18-087af46cec33` | 7 | `2026-10-08T17:55:42.240Z` | `b69638868253f613f13e18de1402aca89d31098df01b91b7db2374be08787d61` |
| `25b90839-ec70-4051-bf4e-8a27cdde54bb` | 3 | `2026-10-08T15:07:57.070Z` | `d088c0e80f48330f27048e240c158484b17b180171be2ce05d6f0fc5ae8e4051` |
| `8222ea04-fad5-433b-89bb-32834648b3f2` | 10 | `2026-10-09T07:45:26.919Z` | `53840a9f7e9bb6669dd17ed27861efe9aee9e8167b3a474d1b74f755f351f98a` |
| `458caed6-6e40-4d1b-8453-511d1accbc13` | 5 | `2026-10-08T15:05:06.902Z` | `3c1941cc27b6da1a1f5fab14a9cd7ffe18bba33a8e69748a75729414970c36e1` |
| `d21d0367-d626-41ae-ab43-3999cd0f7bca` | 23 | `2026-10-08T15:05:09.056Z` | `46a1bfbfad8eaa364177a3cf1b95fd23768f6e0a61361c436d94f0b2a18e3c8a` |
| `336b720f-77af-4e3c-8d32-1570c0859916` | 12 | `2026-10-09T07:46:00.722Z` | `69db34c1f458ff638d42730006428b3e6f4d71fd44b1e6a8e55fc3e5e4230c54` |
| `457b5bb0-5c1e-4fe3-a5fa-9cbbc7e10a0b` | 3 | `2026-10-08T18:04:27.907Z` | `4e96a15e31de9c255d18e350284eafc731cafcd199a71e4462121128cecf7653` |
| `40cd3463-febf-4e50-8603-115e8c89a562` | 6 | `2026-10-08T15:05:14.505Z` | `28935119d39d6c83156159446c0bc19d50ac3118acac3297bd651212c14a1839` |
| `43d0ae09-1fd6-4989-8dd3-84ad252a3c2e` | 2 | `2026-10-08T18:35:56.452Z` | `bce5e92545d9b717f19c90d3d60ae094d925b8d34b8cf0763d14e6802612d54b` |
| `667a50e4-39eb-42db-8ff9-809dba28bcd4` | 4 | `2026-10-08T15:08:39.797Z` | `596d0c2f38598cbc733ca02c56e9acb516290c060853ebeebaa59e7fd5dae6c8` |
| `73837dce-dfe5-4081-a02d-a4bc92a18f2e` | 3 | `2026-10-08T15:08:18.448Z` | `773c17211c76bcbf92d505cf3c84bbfd7435055bd8224657888ec2dbc009267e` |
| `02cbb528-c425-47cd-a5b8-b8ee71951048` | 10 | `2026-10-10T19:39:29.427Z` | `18a494eefa06e543d5a2f85369bc7fc196095010e54a3cd11b6272f478acff44` |
| `d86d18fc-0c8e-4967-bec9-842047d332e7` | 4 | `2026-10-08T15:05:44.361Z` | `904ce0acda23b3e42eab58cb655284b54032cf5b752efe44aba0b611c8870d24` |
| `49796144-fb74-4247-90b3-ecd08f813a04` | 9 | `2026-10-08T15:05:46.233Z` | `84eee441383fc34130ff68c882d142a3a4f05df7be2fce6b43fde51fa9f23f91` |

Metadata revision computed with the CRM's algorithm: `0a23603ea96b8821fdc4660a0cb5fdac55feff8ca7da751220c6298e9b006f1b`.

Revision check, stated precisely: the adapter reads each workflow's id, location, status, updated time and version and
hashes that **metadata**. A workflow whose metadata changes after approval changes the inventory revision and defers all
writes. The adapter does not re-fetch or hash workflow definitions, and definition hashes supplied in the review are the
owner's evidence, not values re-verified per request. Whether every definition edit moves the provider's updated time or
version is a provider behavior this repository has not verified.

## 6. Permission effects
Writing consent or suppression fields changes what native workflows may see. Writes only ever record local state
(allowed or suppressed) and never grant a channel the local contactability decision denies. Local send authority is
unchanged; global outbound pause, email/SMS/cold-email pauses and sequence controls are not touched by this review.

## 7. Scope
The existing CRM population is processed by the ordinary workers under a durable, code-defined scope (no manual release
batches). The effective rules are part of the approval (section 9): changing any of them without a new review blocks writes.
- A production (`record_class = 'production'`), non-archived contact that already carries a GHL contact id is in scope for
  profile/permission updates. Contacts of any other record class are never in scope.
- An unlinked production contact is in scope for a create when it has a source event in a create category, at any date.
  Default categories: `website_form`, `partner_referral`, `merchant_application`, `manual_crm` (current intake) plus
  `csv_import`, `discovery`, `prospect_conversion` and `legacy_unknown` (existing population).
- A source-less legacy production contact (no source event) is in scope for a create only when its `lead_source` label is
  present and is not a registry label; no source event is fabricated for it. `sourceLessLegacy: false` turns that off.
- Registry (`registry_import`, `registry`, Sunbiz, DBPR) records are never in scope and can never be named into scope.
  Identity matching, inbound sync, test/demo/synthetic and archived records are out of scope. Contact age never grants
  scope; suppression is enforced at dispatch and scope never clears it. Existing GHL identities are resolved (strict
  lookup) before any create.
- `system_settings.ghl_export_policy.existingPopulation.enabled = false` switches the scope off. `createSourceCategories`
  replaces the default list, so it can narrow it or add categories to it by listing them (registry categories are always
  removed).
Because the tag component never replaces tags, already-linked contacts are no longer held for tag-loss reasons.

## 9. Persistent approval (no expiry)
An approved review has no calendar expiry. It stays valid until the owner revokes it or the reviewed contract changes;
a day, a restart or a publish with an unchanged contract changes nothing. It is bound to: location; method/path templates
with body-field allow-lists; custom-field id/key/dataType; the two owned tags; the workflow inventory and per-workflow
evidence; the export-scope rules; the approval contract version; reviewer; review time; evidence reference; revocation state.
- Provider evidence unavailable or stale (outage): writes are held before dispatch, no provider failure budget is spent,
  and they resume automatically when the same contract is verified again.
- Proven change (workflow added/removed/changed, field map changed, scope rule changed): writes are blocked, the changed
  facts are reported, and a new owner review is required. It is never approved automatically.
- Revocation blocks writes including retries and in-flight requests at their final recheck. Legacy time-limited,
  expired, default or revoked reviews never gain authority and are not converted.
- Lease expiry in the panel is the runtime lease, not the approval.
- Residual: the public workflows endpoint returns metadata only (id, status, version, updatedAt). Verification compares
  that metadata; it is not a hash of the workflow definition, so a definition edit that does not move `updatedAt` or
  `version` cannot be detected by the platform. Change detection latency is bounded by the 20 second evidence cache.

## 8. Owner checklist (not performed by an agent)
1. Read the live field inventory; the ids/types are in section 3 (types are evidence only; the hash binds id/key).
2. Decide about installing `lb_do_not_contact` / `lb_do_not_autocontact` (exact spec in section 3), then refresh the inventory.
3. Review the per-workflow evidence (section 5, already recorded).
4. Approve in the Activation Panel the operations in section 1 (including the two tag endpoints) with the owned-tag allow-list in section 4; separately enable
   permissions; separately select the runtime.
5. Observe ordinary existing-population processing (selected/attempted/deferred/applied/partial/held/ambiguous counts, oldest
   pending age, component outcomes) before any wider scope.
