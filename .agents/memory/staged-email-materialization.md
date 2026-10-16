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
- Attribution needs retained business-to-site evidence: candidate crawl domain == businesses.website_domain (snapshotted in the immutable evidence row), even for Gmail. The native branch also binds the contact's own email hash to the staged candidate hash; a decision for a different address on the same domain is rejected.
- Existing-contact reuse must take graph advisory locks (contact node, then business nodes/membership) BEFORE the contact row lock, same as admin/system writers. Peek the contact id unlocked, fence, then FOR UPDATE and re-verify.
- Changing the routine again: publish a new migration (never edit an applied one) and keep the legacy production pin accepted for old writers, strict current pin for first-party writes, or Publish alone breaks every link writer.
- Managed Publish diff has tables/columns/indexes/FKs only, no functions or triggers. The routine replacement and evidence immutability trigger are installed automatically at production startup by the native object reconciler (console batch in docs/certification is a manual fallback). Until installed the materializer returns nativeBlocked and writes nothing. Disposable certs may not use 'live' in names (guard rejects it, e.g. 'delivery').
- Byte-exact production routine body lives in scripts/certification/fixtures; reconstructing it from migration lineage is unreliable (0325/0329 also edit it).
- Named evidence is person-subject (business_id null by DB constraint), so it cannot be materialized to a business. Only role evidence qualifies.
- Role mailboxes get business name + "Contact" as a placeholder, never an invented person.
- Legacy imported contacts have generation 0 and no token hash; bootstrap them under the row lock before linking.
- Holds are durable outcome rows retried after a rule-version change or 24h. The per-business cap counts usable contacts only.
- Evaluate per-business gates in MATERIALIZED CTEs; a per-row correlated vertical check hit the 30s statement timeout.
