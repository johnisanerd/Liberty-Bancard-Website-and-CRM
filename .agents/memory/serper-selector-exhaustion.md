---
name: Serper discovery drop cause
description: Official-domain discovery stops when lookup memory covers the mapped pool, not at the 50,000 counter
---
The program selector excludes businesses with live `sfp_serper_lookup_memory`; with ~96% of the mapped no-domain pool remembered, ticks return `no_current_discovery_work`. The 50,000 provider_controls counter is display only.
**Why:** the drop looked like a budget ceiling but selector outcomes showed memory exhaustion.
**How to apply:** check selector/memory outcomes before suspecting the ceiling; new yield needs memory expiry or the closed unlabeled scope.
