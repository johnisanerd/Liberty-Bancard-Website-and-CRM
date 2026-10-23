# CTA and destination map

| Journey | Primary action | Destination | Status |
|---|---|---|---|
| Sales receipt | none (pure receipt) | n/a | implemented |
| Statement upload (workflow B proposal) | Upload your statement | `/upload-statement` (exists) | proposed |
| Partner application | Apply as this partner type | `/iso-partner` form | implemented |
| Admin review of partner/privacy | Open record | `/dashboard/referral-program`, `/dashboard/data-requests` | implemented (in-app notification link) |
| Acknowledgement admin | Enable transactional purpose | `POST /api/admin/inbound-acknowledgements/capability` (admin only) | implemented; UI control not built |
