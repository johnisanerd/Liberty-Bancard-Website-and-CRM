# GHL native review: owner action sheet (prepared 2026-10-25; not an approval)

Only the owner records this review, in the Activation Panel, under the owner's own login. Nothing here approves anything.
Evidence entries (per-workflow disposition, definition hash, evidence reference, change metadata) come from the owner's
own inspection of the 14 workflows in the GHL application; the platform cannot supply or verify a definition hash.

## Production state when prepared (2026-10-25, after the 25b560ee publish)
- Served build: SHA `25b560ee…`; migration 0377 table present; runtime owner lease live.
- Controls: enabled, permissions enabled, owner profile `ghl-sync-only`, current runtime selected. Review state: unverified,
  so every provider write is held before dispatch.
- Custom-field inventory (11 fields) revision: `814549f1cdbbe19f1d9a4ff2d603ce9936e9bc0aa034b51130573dbef33ea943`.
- Workflow inventory: 14 workflows, revision `0a23603ea96b8821fdc4660a0cb5fdac55feff8ca7da751220c6298e9b006f1b`.
- Scope rules revision: `adcb650d07538e0a1dec0ca47a2f538805b9ab39eabd60b38965c91bf3e2bc17`
  (production-only; create categories website_form, partner_referral, merchant_application, manual_crm, csv_import, discovery,
  prospect_conversion, legacy_unknown; source-less legacy by lead label; registry never).
  Re-read all three from the panel at review time; if any changed, the panel's values win.
- New suppression fields (installed 2026-10-25): `contact.lb_do_not_contact` = `wMFGgmIS3puA0NjVnQO5`,
  `contact.lb_do_not_autocontact` = `aAUS7lQpK15mBGx0QAD6` (both TEXT; display names "LB Do Not Contact" /
  "LB Do Not Autocontact").

## Operations JSON for the review form
Reviewed custom-field ids: lb_do_not_sdr `Rfo6frTXZrzZtbUKsNN1`, lb_pain_points `CpXFAsahrrp9J837HHI1`,
lb_promo_code `86igW42wnYpLVGMWADrj`, lb_lead_source `Rog35nsPLTFPa4A1UOJD`, lb_consent_sms `k3gqyGYfAgTalYoYPa8P`,
lb_consent_email `0rhXcXVAQCBxrFtPU5uY`, lb_do_not_contact `wMFGgmIS3puA0NjVnQO5`, lb_do_not_autocontact `aAUS7lQpK15mBGx0QAD6`.

```json
[
  {"method":"POST","path":"/contacts","fields":["locationId","firstName","lastName","email","phone","companyName","customFields"],"tags":[],"stageIds":[],
   "customFieldIds":["Rfo6frTXZrzZtbUKsNN1","CpXFAsahrrp9J837HHI1","86igW42wnYpLVGMWADrj","Rog35nsPLTFPa4A1UOJD","k3gqyGYfAgTalYoYPa8P","0rhXcXVAQCBxrFtPU5uY","wMFGgmIS3puA0NjVnQO5","aAUS7lQpK15mBGx0QAD6"],
   "purpose":"Create a missing production contact identity with profile and suppression fields",
   "safetyEvidence":"Body carries no tags; no workflow id; native workflows do not trigger on these fields (approval package sections 3 and 5)"},
  {"method":"PUT","path":"/contacts/:contactId","fields":["firstName","lastName","email","phone","companyName","customFields"],"tags":[],"stageIds":[],
   "customFieldIds":["Rfo6frTXZrzZtbUKsNN1","CpXFAsahrrp9J837HHI1","86igW42wnYpLVGMWADrj","Rog35nsPLTFPa4A1UOJD","k3gqyGYfAgTalYoYPa8P","0rhXcXVAQCBxrFtPU5uY","wMFGgmIS3puA0NjVnQO5","aAUS7lQpK15mBGx0QAD6"],
   "purpose":"Update identity, profile, permission and suppression fields of a linked contact",
   "safetyEvidence":"Body carries no tags array and no workflow id; only reviewed field ids (approval package sections 1 and 3)"},
  {"method":"POST","path":"/contacts/:contactId/tags","fields":["tags"],"tags":["LB-ACTIVE-PIPELINE","lb_parent_account"],"stageIds":[],"customFieldIds":[],
   "purpose":"Add the two CRM-owned tags only",
   "safetyEvidence":"Neither tag matches any inspected native workflow trigger (approval package sections 4 and 5)"},
  {"method":"DELETE","path":"/contacts/:contactId/tags","fields":["tags"],"tags":["LB-ACTIVE-PIPELINE","lb_parent_account"],"stageIds":[],"customFieldIds":[],
   "purpose":"Remove the two CRM-owned tags only",
   "safetyEvidence":"Removal limited to the two owned tags; all GHL-owned tags are untouched (approval package section 4)"}
]
```

## Steps
1. Open the Activation Panel, GHL native review. Confirm the three revisions above (or note the changed ones).
2. For each of the 14 workflows record disposition, definition hash, evidence reference and change metadata from your
   own inspection. Evidence already recorded in `docs/ghl-native-safety-approval-package.md` section 5 is a starting point.
3. Paste the operations JSON, add the overall evidence reference, submit. The approval then has no expiry.
4. Also needed before writes start: the `ghl-sync` automation kill switch is on in the Automation Registry (separate
   control, not changed by the agent). Release it when you want the worker to run.
