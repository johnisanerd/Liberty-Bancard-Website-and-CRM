---
name: Staged-email materialization
description: Staged first-party emails become contacts linked at creation to their original business through a first-party evidence kind in the native link guard.
---

Staged emails are encrypted free_discovery_candidates rows that already carry business_id. They are materialized automatically (SFP continuous tick, no operator route) into a contact AND a verified link to that exact business, in one transaction, via a dedicated first-party evidence kind in the audited link authority. The first-party evidence kind is enforced natively by enforce_reviewed_contact_business_link(). The earlier "write unlinked, let link automation do it" design is superseded; the user rejected the claimed ZeroBounce-before-link circularity.

**Why:** the old design discarded known business identity, and name re-matching is lossy. Impersonating another source type or bypassing the guard was ruled out.

**How to apply:**
- Association (identity facts only) is separate from vertical/outreach eligibility, validation, activation and recipient limits. The native branch checks candidate, hash, domain basis, shared-domain, rival hash, quarantine and no current link, never ZeroBounce or vertical. Preparation later makes the pending-validation intent or reuses a receipt.
- Any change to the reviewed-link function body changes its pinned inverse-address md5 (canonical-address-receipt-contract.ts). It is also pinned in the native-verification certs (contact-link-automation, owner-repair). Update all in lockstep.
- A mailbox-provider domain (gmail etc.) is never a business-owned domain, in both the TS and the native branch.
- Named evidence is person-subject (business_id null by DB constraint), so it cannot be materialized to a business. Only role evidence qualifies.
- Role mailboxes get business name + "Contact" as a placeholder, never an invented person.
- Legacy imported contacts have generation 0 and no token hash; bootstrap them under the row lock before linking.
- Holds are durable outcome rows retried after a rule-version change or 24h. The per-business cap counts usable contacts only.
- The native quarantine branch is not covered by the disposable cert (needs an sfp_cohort_runs fixture).
- Evaluate per-business gates in MATERIALIZED CTEs; a per-row correlated vertical check hit the 30s statement timeout.
