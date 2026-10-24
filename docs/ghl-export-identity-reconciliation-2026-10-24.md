# GHL export identity reconciliation (aggregates only, dated 2026-10-24)

Source: the user-supplied GHL contact export (3,630 rows, 3,630 unique contact IDs, 2,241 rows with email,
1,389 phone-only) joined read-only to production `contacts` (161,025 rows) on 2026-10-24. No contact data was
changed, no provider call or export was made, and the file was not re-uploaded. No identifier, email or phone appears here.

Each export row is placed in exactly one group, in this order:

| Group | Rule | Export rows |
|---|---|---|
| A. Already linked | a local contact carries this exact GHL contact ID | 2,158 |
| B. Email match, different link state | not A; same lower-cased email as an active local contact | 41 |
| C. Phone-only match | not A/B; no email in export; same 10-digit phone as an active local contact | 11 |
| C2. Email row, phone-only coincidence | not A/B; has an email that matches nothing; phone matches an active local contact | 15 |
| D. No local identity found | none of the above | 1,405 |

Total 3,630. A has 1,816 email rows and 342 phone-only rows. No local GHL ID is duplicated.

## Detail
- **A (2,158 distinct local contacts).** All are `production` class and active; none has current-intake evidence after
  the 2026-10-23 cutoff. 707 have a pending projection (these are linked updates that stay held until an owner scope is
  chosen); 1,451 have none.
- **B (41 export rows, 57 local contacts).** 8 export rows match more than one local contact. 56 of the 57 local
  contacts have no GHL ID; 1 already has one (and is also in group A). Of the 41 rows, 40 match only unlinked local
  contacts and 1 matches a local contact that is already linked. These are potential identities to review, not
  merge targets; ownership and the exact remote ID decide any link.
- **C (11 export rows, 46 local contacts).** 5 export rows match several local contacts. Phone alone never links, merges or creates.
- **C2 (15 export rows, 20 local contacts).** Informational only; the emails differ, so these are not identity matches.
- **D (1,405).** Not found locally by ID, email or phone. This does not mean they should be created here or that they were deleted anywhere.
- **Local side.** 2,192 local contacts carry a GHL ID. 2,158 are in the export; **34 are absent** (14 production-class
  active, 17 test-class, 3 archived). Absence from this export does not show deletion in GHL; the exact remote ID must be
  read before any change to linkage.

## Limits
- Matching used active local contacts for email and phone; archived contacts were not considered for those two keys.
- Phone matching compares 10-digit US numbers (also accepting a leading 1); other formats were not matched.
- The export has no consent, do-not-contact, workflow or opportunity data. ZeroBounce validity and the "no opt-out tag"
  state are not permission to export or to message.
- Counts are as of this run; the export's own filters and date are not independently provable.

## Effect on export policy
None. Historical rows stay held. Releasing any group (for example A's 707 pending linked updates) is a separate owner
decision made through the one projection authority, with receipts. No second bulk importer.
