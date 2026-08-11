# SPMS Implementation Roadmap

This project is moving from a static MVP into the full SPMS blueprint:
student clearance, supervisor approval, library cataloging, public repository
monetization, and institutional administration.

For machine setup and collaborator instructions, see
`docs/local-development-setup.md`.

For production deployment, tenant domain provisioning, and handover checks, see
`docs/production-deployment-runbook.md`.

For security expectations and vulnerability handling, see `SECURITY.md`.

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
- Guest repository download orders with email attribution, payment references,
  tenant scoping, and watermarked access evidence.
- Clearance receipt verification records.
- Tenant payment split settings for institution/SPMS provider accounting.
- In-app workflow notifications with unread/read state.
- Audit logs.
- RLS policies for students, supervisors, library staff, admins, and public catalog readers.
- Tenant-aware RLS policies and institution resolution for multi-institution data isolation.

## Edge Functions

Deploy all functions:

```bash
supabase functions deploy verify-paystack project-workflow repository-access student-identity verification-lookup scheduled-reports health-check --no-verify-jwt --use-api
```

`verify-paystack`:

- `initialize_clearance`: initializes Paystack clearance payments from the backend with configured fee, reference, metadata, and split/subaccount rules.
- Verifies Paystack transactions server-side.
- Confirms the stored upload begins with the PDF signature, matches the submitted size when storage reports it, and belongs to the authenticated student's private folder.
- Creates the legacy `submissions` and `payments` records.
- Creates a real `projects` workflow record when `spms-core.sql` has been applied.
- Falls back to legacy behavior if the workflow schema is not installed yet.

`project-workflow`:

- `supervisor_decision`: approve or request revision.
- Validates revision objects from private storage before changing the project record.
- `library_publish`: verify metadata, assign shelf number, publish anonymized catalog record.
- `issue_receipt`: issue final clearance receipt after library publication.
- Emits in-app notifications for submissions, supervisor approvals/revisions, library publication, and receipt issuance.

`repository-access`:

- `get_download_url`: checks whether a user already unlocked a published project and returns a short-lived private signed URL to a per-user watermarked PDF copy.
- `initialize_download`: initializes paid repository download payments from the backend with configured fee, reference, metadata, and split/subaccount rules.
- `verify_download`: verifies the Paystack repository download fee, records the transaction split, creates a persistent unlock, and returns a short-lived signed URL to a per-user watermarked PDF copy.
- Public repository downloads require an account with a matric number and institutional email. The authenticated `initialize_download` and `verify_download` actions verify the ₦500 Paystack payment, create a permanent account/project unlock, and return a short-lived matric-watermarked PDF copy.
- `student-identity` validates the school email and matric against a configured SIS adapter, falling back to the tenant registry for the KASU pilot without exposing registry rows to the browser.
- Payment records use the tenant-configured institution/provider split percentages and keep Paystack subaccount codes in metadata for reconciliation.
- Uses `pdf-lib@1.17.1` in the Edge Function to stamp repository downloads with user identity, timestamp, project ID, and project title.

`verification-lookup`:

- Public QR/receipt verification endpoint.
- Verifies clearance receipt codes.
- Verifies published project catalog QR payloads without exposing private PDF paths.
- Renders server-generated SVG QR assets for official receipts and catalog labels.

`scheduled-reports`:

- Lets admins generate one-off CSV reports from the dashboard.
- Runs due report schedules for student registers, project lifecycle, financial, and archive reports.
- Financial reports include authenticated clearance and repository payments. The legacy `guest_download_orders` table remains tenant-scoped for migration/audit compatibility, but unauthenticated guest payment actions are disabled.
- Stores generated CSV files in the private `reports` storage bucket.
- Supports authenticated admin execution or external cron execution through `REPORT_CRON_SECRET`.
- Optionally emails private signed report links through Resend when report delivery secrets are configured.

`health-check`:

- Reports production health for monitoring and handover checks.
- Verifies Supabase environment, REST database reachability, and required private storage buckets.
- Returns detailed checks only when `HEALTH_CHECK_SECRET` is absent or supplied through `x-health-secret`.

## Frontend Upgrade

- Student dashboard now collects title, abstract, degree, and PDF.
- Student dashboard shows workflow status and only reveals receipt after publication/clearance.
- Students can replace a revision-requested PDF and resubmit through `project-workflow` without paying the clearance fee again.
- Supervisor dashboard can load real assigned `projects`, securely preview private thesis PDFs with short-lived signed links, and call approval/revision actions.
- Library dashboard can load approved projects and publish them to the public catalog.
- Configured tenants read live anonymized `public_catalog` records without silently falling back to demo data after a database error.
- Public repository download buttons now route through Paystack and the `repository-access` function for paid unlocks.
- Paid repository PDFs are generated as watermarked copies before a signed download URL is returned.
- Admin dashboard can read `admin_overview` metrics and department activity, with legacy fallback.
- Admin settings can load and save tenant branding, clearance fee, download fee, PDF limit, and currency through `institutions` and `system_configs`.
- Admin settings can configure institution/provider revenue share percentages, Paystack split codes, and subaccount codes.
- Clearance and repository payments are initialized server-side before the browser resumes Paystack checkout.
- Successful clearance verification automatically assigns a project to the least-loaded supervisor in the student's department/institution; projects without an eligible supervisor remain `submitted` and notify admins for assignment.
- Admins can resolve the no-match path from Supervisor Management by assigning an eligible teacher through the protected `assign_supervisor` workflow action.
- Library publishing and clearance receipts now render QR codes tied to the verification endpoint.
- QR codes prefer server-rendered SVG assets from `verification-lookup`, with browser rendering as fallback.
- Public repository includes a receipt verification form.
- Admin academic hierarchy management can create colleges, faculties, and departments from the dashboard.
- Logged-in users have a notification center with unread badges and mark-as-read support.
- Admin reports can export student registers, project lifecycle/accreditation data, payment split records, financial PDFs, and archive/audit logs.
- Admin report automation can create recurring schedules, store report recipients, run due reports, generate one-off report files, email private signed links when configured, and download generated CSV artifacts.
- Admin finance views include authenticated clearance and repository payments in the same reconciliation stream.
- Production email deliverability handover is documented for SPF, DKIM, DMARC, authenticated sender alignment, bounces, complaints, suppression lists, and provider rollback.
- Admin analytics now include workflow funnel, revenue split, monthly revenue trend, publication progress, and workflow signal panels backed by live records.
- Frontend tenant resolution supports URL slug selection, configured default tenant slug, custom domain lookup through `institutions.allowed_domains`, and tenant-specific branding/config.
- Public portal UI now uses a visual first screen, restrained card radius, clear action hierarchy, and mobile-first viewport behavior.
- Cloudflare DNS tenant provisioning can be previewed or applied through `npm run dns:cloudflare`.
- Health monitoring is available through the `health-check` Edge Function.
- `npm run verify:deploy` checks live Supabase Edge Function preflight routes, detects missing deployments, validates CORS headers, and calls the production health endpoint.
- `npm run verify:a11y` checks static accessibility basics: document metadata, image alt text, form labels, named buttons, focus safety, and responsive type guardrails.
- `npm run verify:config` checks browser-safe Supabase/Paystack configuration, anon JWT project matching, placeholder rejection, and secret hygiene in frontend files.
- `npm run verify:db` checks SQL run order, RLS coverage, foreign keys, indexes, constraints, private storage buckets, and `SECURITY DEFINER` search paths.
- `npm run verify:dr` checks backup scope, RPO/RTO, restore drills, storage recovery coverage, post-restore validation, and incident handover evidence.
- `npm run verify:governance` checks data classification, retention, data subject requests, access review, public/private boundaries, private buckets, and governance handover evidence.
- `npm run verify:edge` checks Edge Function CORS preflight behavior, allowed methods, action/type contracts, JSON error handling, deploy config, and live smoke verifier coverage.
- `npm run verify:email` checks production email deliverability handover, mail-secret safety, signed report links, and scheduled report fallback behavior.
- `npm run verify:monitor` checks uptime, health-check, cron, payment, email, alert routing, incident evidence, and monitoring handover coverage.
- `npm run verify:render` captures Chrome/Chromium desktop and mobile screenshots from the local app and validates that rendered pages are non-trivial PNGs.
- `npm run verify:roles` renders local-only student, supervisor, library, and admin preview surfaces in Chrome/Chromium and checks role-specific DOM content plus screenshots.
- `npm run verify:interactions` opens local-only workflow states for student receipt, supervisor review, library cataloging, and admin reports to catch broken modal/section interactions.
- `npm run verify:playwright` runs browser-level role workflow checks for student receipt, supervisor review, library cataloging, and admin reports; seeded Supabase account checks are available through local environment variables.
- `npm run verify:security` checks secret hygiene, RLS coverage, private storage, Edge Function CORS/auth patterns, and payment safety.
- `npm run verify:ui` checks role dashboard surfaces, inline actions, duplicate ids, and admin UI regression guards.
- `npm run verify:workflow` checks frontend/Edge Function action contracts, verification types, workflow statuses, transaction types, report types, and role checklist coverage.
- `npm run verify:release` checks release docs, env template coverage, and obvious private secret leaks.
- `npm run verify:lifecycle` validates the static app, Edge Functions, schema capabilities, deploy script, and local server smoke status.
- GitHub Actions workflow runs rendered UI screenshots, role rendering, role interaction checks, and lifecycle verification for pushes and pull requests.

## Live KASU Verification

- The linked project `tejkksgyqltudpfuzjdo` contains the KASU tenant, the
  tenant-scoped repository audit table, the private student registry, and the tenant-aware
  `current_institution_id()` helper.
- All seven Edge Functions, including `student-identity`, are deployed with browser-safe preflight handling, and
  the live deployment verifier reports `health-check: ok`.
- Live identity smoke verification accepts the seeded KASU matric/school-email
  pair and the repository endpoint rejects unauthenticated guest actions.
- The four documented demo accounts authenticate successfully against the hosted
  project and reach their student, teacher, library, and admin workspaces.
- The hosted database currently has no project/catalog records, which is
  expected until a real thesis submission completes the workflow.

## Still Remaining

- Real provider-side email domain authentication and deliverability monitoring with institution DNS access.
- Provider-specific production DNS credentials and hosting target values for each institution.
- Full Playwright role automation against seeded Supabase test data; the authenticated smoke suite now passes for the four hosted demo accounts, while broader project-data scenarios still need a dedicated test dataset.
- A genuine end-to-end smoke test with a real Paystack test transaction, private PDF upload, supervisor review, library publication, QR verification, and paid repository download.
- A genuine authenticated repository payment smoke test for a registered student, including the ₦500 transaction, permanent unlock, matric watermark, admin ledger visibility, and financial report inclusion.
- Production hosting, institution DNS, email provider credentials, monitoring endpoints, and rollback evidence for each tenant.
