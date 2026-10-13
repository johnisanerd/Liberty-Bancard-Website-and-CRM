---
name: Retained native snapshot parity
description: Safe restoration of private native graphs when production and disposable schemas differ.
---

Prove the source column inventory separately from the retained rows. A missing
source column is not a source NULL: use the actual additive migration default,
while retaining every explicit source value and checking every original field.

**Why:** Inserting every destination column through jsonb_populate_recordset
turned source-absent additive columns into NULL, bypassing their real defaults.

**How to apply:** Reject missing original fields and unsupported non-null
additions. Verify all source fields after insertion under real native guards.

Restore contact/source-event cycles in canonical A→B→C order: insert the contact
with no primary pointer, insert the original events, then set the exact original
pointer before final field/hash verification and commit.

**Why:** The retained primary-source foreign key is non-deferrable. Deferring
other constraints cannot permit a pointer to a source event not yet inserted,
even when the captured graph contains every referenced event.

**How to apply:** Preserve every original final value and all native guards; do
not alter FK deferrability or omit retained source pointers to make a test pass.

Audit production/disposable constraint parity before claiming that an exact
historical graph can be restored. Do not merge/archive retained contacts or
remove a uniqueness constraint merely to make certification pass.

**Why:** The extended production export contained active duplicate email
identities, while production lacked the unarchived-email unique index required
by both the declared application schema and disposable migrations. A narrow
original-row duplicate census does not prove an expanded graph is duplicate-free.

**How to apply:** Treat an unexplained constraint mismatch as an open gate.
Resolve schema ownership/parity explicitly; preserve original topology.

Fresh migrated templates can omit surviving legacy indexes from live databases.
Reproduce the actual installed constraint as a negative before certifying a
correction against a template that no longer declares it.

**Why:** A same-brand location certificate passed on a fresh template while the
live database still rejected legitimate branch creation through historical
domain-wide uniqueness. Matching current schema source did not establish
installed native parity.

**How to apply:** Compare actual catalogs and exercise the native writer with
the legacy constraint present, then deliver the approved identity correction
forward and prove record preservation and concurrent replay.

Restore immutable historical decisions under the independently verified
capture-era native contract, then apply the declared migrations forward before
running corrected workers. Never insert old-version decisions through a newer
guard by widening its accepted hashes or rewriting historical evidence.

**Why:** New-write validation correctly rejects a historical decision version
that can legitimately remain stored across a normal policy upgrade.

**How to apply:** Verify the real source-era function fingerprints, keep all
native guards enabled during restoration, and require the corrected verifier
after forward delivery. Keep restoration and upgraded execution proof separate.

Native INSERT triggers can recompute mutable projections while loading a graph.
Restore the capture's exact final projection values after its base rows exist,
then verify every source field before commit; do not accept recomputed values as
historical parity.

**Why:** Loading original work items recalculates batch counters and timestamps,
even when the capture's own counters reflect an earlier projection state.

**How to apply:** Preserve source values, real CHECKs and triggers. Diagnose
differences by field names/counts, without logging private original values.

A retained graph must include subjects referenced by fulfillment receipts,
including business-only rows, not just businesses reached through contacts.

**Why:** Exact verification of captured rows does not prove closure: valid
business-only fulfillment receipts can reference businesses absent from a
contact-derived export.

**How to apply:** Check receipt/contact/business/source-link/location closure.
Keep the original capture immutable, extend it in a new private artifact, and
independently reverify source scopes and added leaves before native acceptance.
Separate blank-email projection repair from real email-identity reconciliation.
A duplicate email does not by itself prove two contact records are the same
person; existing verified relationships must not be transferred to make an
index fit.

**Why:** A full production census included both many blank-email records and
syntactic-email duplicates, including an affected current relationship.

**How to apply:** Obtain authorization for live record correction, retain source
history, and use corroborating identity evidence before merging or archiving.
Do not describe a captured-ID hash comparison as whole-database acceptance.

The user authorized audited blank-email normalization to NULL and archival of
only evidence-confirmed duplicate contacts, preserving original imports,
history and valid relationships. The owner subsequently chose to allow distinct
CRM contacts to share an email under identity/source-based duplicate protection.
Login-account email uniqueness remains unchanged. This is not authorization to
archive genuinely different businesses/locations that share a mailbox.

**Why:** The owner explicitly selected audited correction; the census also
contained separate storefronts sharing corporate/support mailboxes.

**How to apply:** Complete confirmed corrections through existing audited
commands. Keep ambiguous identities intact. Deliver the owner-approved CRM
mailbox contract through supported versioned migrations, never by disabling
guards in a certification fixture. Require source/identity corroboration rather
than treating mailbox equality as proof of a duplicate.

The production SQL reader can truncate a complete result near one MiB and can
cancel a read because of replica recovery. Successful bounded exports do not
by themselves prove an atomic, complete graph.

**Why:** Large native exports failed or lost their result, and ongoing recovery
added receipts while tables were captured separately.

**How to apply:** Keep inputs private, export bounded data, and independently
prove inventory completeness and revision coherence before accepting a snapshot.

Keep source verification SQL compact. Large inline per-row hash inventories can
fail the production reader's command-argument limit; a single scoped table-hash
census avoids that while retaining a coherent comparison across tables.

**Why:** A multi-megabyte verification statement failed with `spawn E2BIG`;
separate successful data exports were still rejected by the coherent hash census
because automatic recovery changed the mutable graph during extraction.

**How to apply:** Persist private per-chunk proof rather than accumulating large
decoded results in the notebook. Do not issue a verified manifest when any
required source table or scope inventory differs.

Do not depend on /tmp as the only copy of long-running private certification
inputs. It can disappear on a workspace restart; losing it is not loss of live
import data.

**Why:** A workspace restart removed temporary retained exports and interrupted
the release run while the source execution still retained all original raw rows.

**How to apply:** Use explicitly ignored private workspace storage with restrictive
permissions when authorized; never commit raw data or authority tokens, and do
not call separately captured mutable records an atomic native snapshot.
