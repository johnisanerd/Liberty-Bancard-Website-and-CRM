---
name: Partner/affiliate intake resume and review policy
description: Shared partner-application routine, replay resume, and why review owner/due are never invented.
---
Partner and affiliate applications share `completePartnerApplicationLocal` / `resumePartnerApplication` and the `website_form|partner_application` source contract. Affiliate signup requires an Idempotency-Key. Replay with no durable account fails truthfully (password is not stored). Review owner/due come only from an admin-recorded policy (`inbound_review_policy` system setting, PUT /api/admin/inbound-review-policy); otherwise metadata says `not_configured`.
**Why:** no SLA exists to disclose; public pages must not promise timings (partner "24 hours", privacy "30 days" removed).
**How to apply:** add public timing copy only together with a recorded policy. Approval/welcome work is now durable (see partner-approval-delivery-and-binding.md).
