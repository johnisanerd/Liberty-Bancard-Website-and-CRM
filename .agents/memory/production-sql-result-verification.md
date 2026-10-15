---
name: Production SQL result verification
description: Validate the actual returned result before treating a production read as successful.
---

Check the returned result header or explicit value, not only the production SQL
callback's success flag.

When the same bound UUID is compared to both a UUID column and JSON text,
cast that parameter explicitly at each predicate (`uuid` and `text`).

**Why:** PostgreSQL can infer the parameter as UUID from the first predicate
and then reject the JSON-text comparison; removing only the first explicit
cast does not solve that mixed-type reuse.

**How to apply:** Check native column types and both uses of a reused parameter
before retrying. Require an actual returned header/value after the correction.

**Why:** Invalid read-only queries returned success=true with only START
TRANSACTION and ROLLBACK in output, without exposing the underlying SQL error.
That output was not a successful empty census.

**How to apply:** If the expected columns or aggregate result are absent, treat
the check as unverified. Inspect the live schema and query syntax, then rerun the
corrected read; never report zero records or use it as mutation evidence.

Large production SQL results can be truncated at 1 MiB while still reporting
success. Do not parse or certify a partially returned cohort.

**Why:** A successful original-row read was cut in the middle of CSV/JSON;
retrying the complete cohort did not recover the omitted rows. Retaining raw
and parsed copies also exhausted the notebook's memory and reset its state.

**How to apply:** Fetch bounded source-coordinate pages, reject truncation
markers, and assert each page's expected cardinality and the complete coordinate
union. Persist private pages promptly and retain only small summaries in the
notebook; process bulky saved evidence locally rather than accumulating copies.

Notebook file operations also have a combined 3 MB budget per code block.
Budget exhaustion can discard notebook variables while earlier page files remain.

**Why:** A bounded cohort read avoided per-query truncation but exceeded the
combined file-operation budget while persisting many pages in one block.

**How to apply:** Limit each block's persisted pages, inspect the existing page
union after interruption, and resume only missing coordinates in a fresh block.
Reconstruct variables from saved files rather than assuming notebook state survived.

After a verification-workspace restart, recheck the filesystem's complete
coordinate manifest even when a pre-restart operation reported success.

**Why:** A workspace restart interrupted the observer and left a partial set of
compiled verification queries while the retained input pages survived. Earlier
tool output was not proof that the complete generated cohort was still present.

**How to apply:** Preserve existing observations, regenerate only missing derived
evidence, and assert the exact distinct coordinate union before certification.
Resume an observer only against its pinned build and preserve its original
deadline. Verify production separately; a workspace restart is not evidence of
a production process restart.