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

Audit production/disposable constraint parity before claiming that an exact
historical graph can be restored. Do not merge/archive retained contacts or
remove a uniqueness constraint merely to make certification pass.

**Why:** The extended production export contained active duplicate email
identities, while production lacked the unarchived-email unique index required
by both the declared application schema and disposable migrations. A narrow
original-row duplicate census does not prove an expanded graph is duplicate-free.

**How to apply:** Treat an unexplained constraint mismatch as an open gate.
Resolve schema ownership/parity explicitly; preserve original topology.
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
history and valid relationships. This is not authorization to archive genuinely
different businesses/locations that share an address or alter global email
uniqueness merely to make a retained graph restore.

**Why:** The owner explicitly selected audited correction; the census also
contained separate storefronts sharing corporate/support mailboxes.

**How to apply:** Complete confirmed corrections through existing audited
commands. Keep ambiguous identities intact and obtain a scope decision before
changing their representation or the global contact-email identity contract.

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
