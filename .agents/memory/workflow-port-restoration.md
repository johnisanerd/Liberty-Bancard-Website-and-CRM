---
name: Workflow port mapping restoration
description: Removed external mappings can return while a workflow retains its waitForPort declaration
---

When removing an unintended external mapping, check inactive workflow `waitForPort` declarations too.

**Why:** In this workspace, validating removal of the port-6000 mapping succeeded and immediately showed it
absent, but the mapping was restored while the optional preview workflow still declared `waitForPort=6000`.
Removing the eager wait declaration as well left the external mapping removed, without changing its command.

**How to apply:** Use the supported configuration validator, remove only the unintended mapping/declaration,
and verify persistence in a subsequent read. Do not describe a transient successful replacement as final removal.
