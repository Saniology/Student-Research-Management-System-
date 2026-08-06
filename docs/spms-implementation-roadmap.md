# SPMS Implementation Roadmap

This project is moving from a static MVP into the full SPMS blueprint:
student clearance, supervisor approval, library cataloging, public repository
monetization, and institutional administration.

## Current Production Foundation

- Supabase Auth with role-based profiles: `student`, `teacher`, `library`, `admin`.
- Student PDF upload to the private `thesis-pdfs` bucket.
- Paystack clearance payment flow.
- `verify-paystack` Edge Function for server-side payment verification.
- Payment retry recovery in the browser.
- Basic admin payment visibility.

## Core Upgrade Added

Run `supabase/spms-core.sql` after `schema.sql` and `payments.sql`.

It adds:

- Institution and white-label settings.
- Faculties and departments.
- Student-to-supervisor assignment fields.
- Project lifecycle table with statuses from submission to clearance.
- Supervisor review history.
- Library catalog publishing fields: shelf number, QR payload, DOI.
- Public anonymized catalog table.
- Repository unlock records for paid downloads.
- Clearance receipt verification records.
- Audit logs.
- RLS policies for students, supervisors, library staff, admins, and public catalog readers.

## Edge Functions

Deploy both functions:

```bash
supabase functions deploy verify-paystack project-workflow repository-access --no-verify-jwt --use-api
```

`verify-paystack`:

- Verifies Paystack transactions server-side.
- Creates the legacy `submissions` and `payments` records.
- Creates a real `projects` workflow record when `spms-core.sql` has been applied.
- Falls back to legacy behavior if the workflow schema is not installed yet.

`project-workflow`:

- `supervisor_decision`: approve or request revision.
- `library_publish`: verify metadata, assign shelf number, publish anonymized catalog record.
- `issue_receipt`: issue final clearance receipt after library publication.

`repository-access`:

- `get_download_url`: checks whether a user already unlocked a published project and returns a short-lived private signed URL.
- `verify_download`: verifies the Paystack repository download fee, records the transaction split, creates a persistent unlock, and returns a short-lived signed URL.

## Frontend Upgrade Started

- Student dashboard now collects title, abstract, degree, and PDF.
- Student dashboard shows workflow status and only reveals receipt after publication/clearance.
- Supervisor dashboard can load real assigned `projects` and call approval/revision actions.
- Library dashboard can load approved projects and publish them to the public catalog.
- Public repository can read anonymized `public_catalog` records, with demo fallback.
- Public repository download buttons now route through Paystack and the `repository-access` function for paid unlocks.

## Still Remaining

- Dynamic PDF watermarking before download.
- Server-generated QR code images.
- Admin settings UI for fees, academic hierarchy, institution theme, and Paystack split rules.
- Real analytics charts backed by `admin_overview`.
- Notifications for student/supervisor/library workflow events.
- Multi-tenant subdomain provisioning.
- Full frontend migration from one large `index.html` into a maintainable React/Next.js app.
- Automated tests and CI/CD.
