---
name: Serper contact-page stage
description: Design rules for the governed Serper contact-page lookup stage and how its yield must be reported
---
Stage selects businesses from the backlog ladder key `website_searched_no_email_recheck`, spends one gateway `/search` request, reads at most three own-domain result pages, and stages role inboxes as ordinary `first_party_contact_page` evidence. Closed unless the `serper_contact_page_stage` setting is enabled with a positive per-run request count.

**Why:** The user wants additional qualified businesses per credit measured, no new queue, no new cap, and skepticism toward low-yield work.
**How to apply:** Never change the first-party link function (pinned hash); record request count separately from provider-reported credits (NULL = unreported); never mine snippets; blocked gateway calls record nothing; the #2090 500/500/3 allowance applies only to its one-time measurement. Report yield only from real runs.
