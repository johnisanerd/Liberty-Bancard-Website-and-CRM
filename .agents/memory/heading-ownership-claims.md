---
name: Heading ownership claims
description: One h1 per mounted composition is a runtime claim, not a route list; how hubs and embedded children stay at h2.
---
Page h1 ownership is a context claim: `PageTitle`/`PageHeader`/`CrmPageHeader` at level 1 register a claim; the employee shell title is only the fallback h1.
**Why:** a hard-coded adopted-page list in DashboardLayout kept drifting and produced zero or two h1s on hubs.
**How to apply:** new page headings use `PageTitle`; hub tab content sits under `<PageHeadingLevel level={2}>`; an embedded-capable page passes `level={embedded ? 2 : undefined}`. Verify by crawling routes and counting settled h1 (settle ~9s; layout-effect claims change after first paint).
