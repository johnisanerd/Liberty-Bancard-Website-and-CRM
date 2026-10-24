# GHL native-safety review: approval package (prepared for the owner; not an approval)

Status: **prepared, not approved.** The review state remains `unverified`. Nothing in this repository, and no agent, may
approve it. Approval is the owner's action in the admin Activation Panel after refreshing the inventory below.

Identity/profile writes, permission/suppression writes and workflow enrollment are three separate things. This package
covers the first two only. Workflow enrollment stays off: no operation below enrolls a contact, adds a workflow id, or
sends a message.

## 1. Operations the projection can perform

| # | Method and template | Capability | Fields (top-level keys) | Purpose |
|---|---|---|---|---|
| 1 | `POST /contacts` | `crm_write` | `locationId`, `firstName`, `lastName`, `email`, `phone`, `companyName`, `tags`, optional `customFields` | Create the contact once, after a strict read-only lookup proved it absent. |
| 2 | `PUT /contacts/:contactId` | `crm_write` | `firstName`, `lastName`, `email`, `phone`, `companyName`, `tags`, optional `customFields` | Update an already linked or just-linked contact. `locationId` is never sent on update. |
| 3 | `PUT /contacts/:contactId` (permission fields) | `permission_write` (needs `permissionsEnabled`) | `customFields` only | Write consent/suppression/lifecycle fields after identity is proven. |
| 4 | `PUT /contacts/:contactId` (tags and `lb_do_not_sdr`) | `crm_write` | `tags`, `customFields` | Active-pipeline and parent-account tagging. Applied only after identity and required permission components succeed. |

Read-only calls used (never gated, never mutate): `GET /locations/:id/customFields`, `GET /workflows/`,
`GET /contacts/search/duplicate?locationId=&email=|number=`, `GET /locations/:id`.

Excluded on purpose: opportunities, notes, tasks, calendars, conversations/messages, workflow enrollment, tag
creation, custom-field creation, deletes.

## 2. Payload rules enforced before and during every request
- Lookup before create. Exact email match is the identity. A phone-only contact is created only when the provider
  confirms that phone is absent; a phone-only match is held for review, never merged.
- A match whose email differs, or several matches, is held with a specific reason (`GHL_IDENTITY_AMBIGUOUS:<reason>`); no write.
- A required suppression (`lb_do_not_contact`, `lb_do_not_autocontact` when true) whose provider field is not installed
  defers the whole projection before any mutation.
- Other optional fields not installed in GHL are recorded as held (visible per contact) and omitted; fields are never created.
- Each custom field is sent by provider id and must match the reviewed id/key pair.
- Final fence before every request, including retries: claim token, unexpired lease, generation, ownership and
  eligibility; a durable operation row is appended first.

## 3. Custom fields (refresh before approval)
Installed on 2026-10-24 (keys only; ids and types must be re-read from the live inventory when the review is
prepared, because the review binds to the inventory hash):
`lb_consent_email`, `lb_consent_sms`, `lb_do_not_sdr`, `lb_promo_code`, `lb_pain_points`, `lb_lead_source`,
`external_contact_id`, `lead_score`, `contact_role`.

Fields the code can emit that are **not installed** (will be held, not created): `lb_do_not_contact`,
`lb_do_not_autocontact`, `lb_lifecycle_stage`, `lb_channel_permissions_updated_at`, `lb_sms_allowed`,
`lb_voice_ai_allowed`, `lb_ringless_vm_allowed`, `lb_manual_call_allowed`, `lb_location_of`, and the profile fields
(`vertical`, `lb_vertical`, `monthly_volume`, `lb_monthly_volume`, `offer_path`, and similar).
**Owner decision needed:** `lb_do_not_contact` / `lb_do_not_autocontact` must be installed before any contact that is
suppressed locally can be exported; until then those contacts defer.

## 4. Tags
Tags written: whatever is already on the contact's local `tags`, plus `lb_parent_account` and `LB-ACTIVE-PIPELINE`
when the rules apply. The review `tags` allow-list must name each. Native workflow triggers keyed on any of these tags
are the review's central question (section 5).

## 5. Native triggers to inspect (owner evidence, workflow by workflow)
For every active/published workflow in the live `GET /workflows/` inventory, record: trigger type (contact created,
contact changed, tag added/removed, custom field changed), any email/SMS/call action reachable from it, and whether a
create/update/tag/field write from section 1 can fire it. The review requires a definition hash and CHANGE metadata
per workflow; the inventory revision must still match at every request, so any edit in GHL after approval defers all writes.

## 6. Permission effects
Writing consent or suppression fields changes what native workflows may see. Writes only ever record local state
(allowed or suppressed) and never grant a channel the local contactability decision denies. Local send authority is unchanged;
global outbound pause, email/SMS/cold-email pauses and sequence controls are not touched by this review.

## 7. Scope
Only contacts with current-intake evidence (website form, partner referral, merchant application, manual CRM entry
on or after the policy cutoff) are exportable. Historical, imported, discovered, registry and test records stay held. No
bulk release exists; releasing any historical scope is a separate owner decision.

## 8. Owner checklist (not performed by an agent)
1. Refresh the field and workflow inventories; attach ids/types.
2. Decide about `lb_do_not_contact` / `lb_do_not_autocontact` installation.
3. Inspect workflows per section 5.
4. Approve in the Activation Panel; separately enable permissions; separately select the runtime.
5. Observe ordinary current-intake processing before any wider scope.
