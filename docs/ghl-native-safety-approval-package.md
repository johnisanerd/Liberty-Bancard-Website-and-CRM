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
| 3 | tags + parent/pipeline fields | `PUT /contacts/:contactId` | `crm_write` | `tags`, optional `customFields` (`lb_do_not_sdr`, `lb_location_of`) | Always after 1 and 2. Sends the full desired tag set (section 4). |

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
  current-intake evidence; a durable operation row is appended first.

## 3. Custom fields
Installed (keys observed on 2026-10-24): `lb_consent_email`, `lb_consent_sms`, `lb_do_not_sdr`, `lb_promo_code`,
`lb_pain_points`, `lb_lead_source`, `external_contact_id`, `lead_score`, `contact_role`.
**Ids and types: to record at review time** from the live inventory (the Activation Panel shows them and the review
binds to the inventory hash). `external_contact_id`, `lead_score`, `contact_role` are installed but are not emitted by
the contact projection.

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

## 4. Tags (exact allow-list)
The tags component sends the **full desired tag set** on every run: the contact's local tags, with `LB-ACTIVE-PIPELINE`
added/removed from active-deal state and `lb_parent_account` added/removed from the parent-account flag. Local tags
change only after the provider accepted the write.

Intended allow-list for the review `tags` field: `LB-ACTIVE-PIPELINE`, `lb_parent_account`. Any other local tag on a
contact is outside the allow-list; the existing review contract then defers that contact's tag write visibly. If the owner
wants other tags exported, each must be named here with its native trigger effect (section 5). On 2026-10-24 production had
**zero** contacts with current-intake evidence, so no other tag is currently in scope.

`PUT` with `tags` replaces the remote tag set. A tag that exists only in GHL is removed by an update. This is a reason
that already-linked historical contacts stay held until a release is scoped.

## 5. Native workflow evidence (record workflow by workflow)
Earlier read-only inventory in this task (2026-10-24, `GET /workflows/`): **14 workflows, 6 published**. Per-workflow
names, triggers and actions were not stored in the repository, so they are **to record at review time**; the table
is the work product, not a request to restart the investigation.

| Workflow id | Name | Status | Trigger type (created / changed / tag added / tag removed / field changed) | Email/SMS/call/enrollment action reachable | Fired by a write in section 1? |
|---|---|---|---|---|---|
| (14 rows to record) | | | | | |

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
Only contacts with current-intake evidence (website form, partner referral, merchant application, manual CRM entry on or
after the policy cutoff) are exportable, whether or not they already carry a GHL id. Historical, imported, discovered,
registry and test records stay held. No bulk release exists; releasing any historical scope is a separate, optional owner
decision and is **not** needed to accept current intake.

## 8. Owner checklist (not performed by an agent)
1. Read the live field inventory; attach ids/types (section 3).
2. Decide about `lb_do_not_contact` / `lb_do_not_autocontact` installation.
3. Record the per-workflow table (section 5).
4. Approve in the Activation Panel the operations in section 1 with the tag allow-list in section 4; separately enable
   permissions; separately select the runtime.
5. Observe ordinary current-intake processing (selected/attempted/deferred/applied/partial/held/ambiguous counts, oldest
   pending age, component outcomes) before any wider scope.
