# GHL native review: owner action sheet (prepared 2026-10-26; not an approval)

Nothing here approves anything and no reviewer is recorded. The owner submits under the owner's own login.

## What the owner does
1. Sign in as the owner and open `/dashboard/ghl-integration?tab=settings` (GHL Integration, Settings tab).
2. In the "GHL CRM Sync" card, find "Native-trigger safety review".
3. Press **Load prepared evidence**. The form fills the four operations, the evidence for all 14 workflows and the overall
   audit reference, and shows a comparison with the live inventory.
4. Read the summary. Proceed only if it says everything matches. If it lists differences, stop: the changed items need
   inspection and a new package, not a pasted hash.
5. Tick the acknowledgement: "I reviewed and accept the attributed evidence (independent GHL workflow inspection of
   October 24, 2026) for the restricted contact-sync scope...".
6. Press **Submit owner approval (contact sync only)**.

The control epoch is read from the live control state by the form at submission; it is not stored in the package.

## What is prepared
- Operations: `POST /contacts`, `PUT /contacts/:contactId`, `POST /contacts/:contactId/tags`, `DELETE /contacts/:contactId/tags`.
  Reviewed custom fields: lb_do_not_sdr, lb_pain_points, lb_promo_code, lb_lead_source, lb_consent_sms, lb_consent_email,
  and the two suppression fields `wMFGgmIS3puA0NjVnQO5` (lb_do_not_contact), `aAUS7lQpK15mBGx0QAD6` (lb_do_not_autocontact).
  Tags are limited to `LB-ACTIVE-PIPELINE` and `lb_parent_account`.
- Workflow evidence: 14 entries from the independent inspection of 2026-10-24 (definition hashes are in
  `docs/ghl-native-safety-approval-package.md` section 5). Source data: `server/data/ghl-prepared-native-review.ts`.
- Revisions at preparation (compared live on 2026-10-26, all equal): workflow `0a23603e…6f1b`, custom fields `814549f1…a943`,
  scope rules `adcb650d…2c17`. The 14 workflows' updatedAt and version equal the recorded evidence.
- Attribution: the evidence is the October 24 independent inspection. It is not a fresh read, and the owner is not asked to
  claim a personal inspection. Change detection compares workflow metadata (status, updatedAt, version); an edit that moves
  none of those cannot be detected.

## Scope of the approval
Contact storage only. It does not cover messaging, workflow enrollment, promotion, opportunities, tasks, notes, calendars
or deletes. `ghl-enrollment-recovery` stays off, and all sends, sequences and promotional enrollment stay paused.
