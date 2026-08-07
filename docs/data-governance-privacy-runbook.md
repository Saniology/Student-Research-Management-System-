# SPMS Data Governance And Privacy Runbook

Use this runbook before production handover and during each academic term. It
defines the data boundary for student research records, payment evidence,
repository access, reports, and public verification.

This is an operational checklist, not legal advice. The institution must confirm
the final retention schedule and lawful basis with its registrar, library,
finance office, and data-protection lead under applicable local privacy law,
including NDPA/NDPR requirements where they apply.

## Governance Owners

- Data owner: registrar, school secretary, or academic records lead.
- Repository owner: library administrator responsible for published catalog
  records and thesis access.
- Payment owner: finance administrator responsible for Paystack reconciliation.
- Technical owner: Supabase/project administrator responsible for RLS, storage,
  Edge Functions, backups, secrets, and monitoring.
- Privacy contact: institution data-protection officer or delegated records
  officer for correction, restriction, export, and deletion requests.

Record the named people, emails, and review dates in the handover evidence.

## Data Classification

Public:

- Published project metadata in `public_catalog`: title, abstract, degree,
  department name, shelf number, DOI, publication timestamp, and QR payload.
- Public verification result fields from `verification-lookup` that prove a
  receipt or catalog record without exposing private storage paths.

Internal:

- Institution, college, faculty, department, tenant domain, and branding
  settings.
- Aggregated dashboard metrics and non-sensitive operational status.

Restricted:

- Student and staff profiles, matric numbers, emails, roles, and departments.
- Project submissions in `projects`, including private `file_path` values.
- Thesis uploads in the private `thesis-pdfs` bucket.
- Clearance payment records, repository download payments, receipts, references,
  split accounting metadata, and Paystack verification details.
- Repository unlocks and watermarked copies in the private
  `repository-downloads` bucket.
- Generated reports in the private `reports` bucket.
- Audit logs, workflow review comments, report recipients, and notification
  records.

Secret:

- Supabase service role key, database password, Paystack secret key, Resend API
  key, report cron secret, health-check secret, Cloudflare API token, and any
  equivalent provider credentials.

## Public And Private Boundary

The public repository must read only `public_catalog`. It must not expose
`projects.file_path`, storage object names, signed URLs, report paths, payment
metadata, matric numbers, emails, private review comments, or audit metadata.

The public verification endpoint may confirm:

- receipt validity, verification code, issue date, student display name, matric,
  department, project title, project status, shelf number, and DOI;
- published catalog validity, title, degree, department name, shelf number, DOI,
  and publication timestamp.

It must not return private file paths, storage paths, signed URLs, raw Paystack
metadata, report paths, audit metadata, or service-level diagnostics.

## Storage Privacy

Keep these buckets private:

- `thesis-pdfs`: original student uploads.
- `repository-downloads`: per-user watermarked repository copies.
- `reports`: generated CSV/PDF/JSON administrative reports.

Access must come from RLS policies, authenticated staff permissions, or
short-lived signed URLs generated server-side. Signed links should expire quickly
and must not be pasted into public chat, issues, screenshots, or documentation.

## Retention Schedule

Confirm the exact period with the institution before launch, then write it into
handover evidence. Minimum operational defaults:

- Student profile, project submission, approval history, receipt, and published
  catalog records: retain for the institution's academic record, accreditation,
  library, and legal retention period.
- Clearance and repository payment records: retain for finance reconciliation,
  audit, refund disputes, and statutory accounting periods.
- Audit logs: retain long enough to investigate access, publication, payment,
  and administrative actions.
- Generated reports in `reports`: expire or delete on a defined schedule after
  download and audit needs are satisfied.
- Watermarked repository copies in `repository-downloads`: short retention is
  preferred because they can be regenerated from the private source after access
  is revalidated.
- Failed uploads, abandoned checkout attempts, and stale notifications: review
  and purge on a scheduled maintenance cycle.

Never delete payment, receipt, audit, or academic records only because a user
asks informally. Route the request through the privacy contact and data owner.

## Data Subject Requests

Requests for correction, access, restriction, export, or deletion must be
recorded with:

- requester identity and relationship to the institution;
- affected student, project, receipt, payment, or catalog record;
- request type and date received;
- data owner decision and lawful basis;
- actions taken in Supabase, Paystack, backups, and exported reports;
- evidence of completion or refusal.

Corrections to public catalog metadata should preserve audit history. Deletion
requests must account for accreditation, finance, legal, library, and audit
retention requirements before records are removed or anonymized.

## Access Reviews

Run an access review at least once per term and after staff role changes.

- Confirm admin, library, supervisor, and student role assignments.
- Remove departed staff and students who no longer need access.
- Confirm allowed tenant domains belong to the institution.
- Confirm report recipients are approved institutional addresses.
- Confirm private buckets are still private.
- Confirm public catalog records do not include private file paths.
- Record reviewer, date, exceptions, and remediation actions.

## Privacy Incident Response

Use `docs/production-monitoring-runbook.md` and
`docs/disaster-recovery-runbook.md` during incidents. For privacy-specific
events:

- preserve Supabase, Paystack, hosting, and application logs;
- identify affected students, projects, receipts, payments, reports, or files;
- revoke exposed signed URLs where possible and shorten future TTL values;
- rotate exposed secrets immediately;
- disable affected report schedules or public links if needed;
- notify the data owner, privacy contact, technical owner, and finance owner;
- document assessment, containment, notification decisions, and recovery
  evidence.

## Handover Evidence

Before production handover, record:

- named governance owners and privacy contact;
- approved data classification and retention schedule;
- latest access review date and reviewer;
- latest public catalog privacy review date;
- proof that `thesis-pdfs`, `repository-downloads`, and `reports` are private;
- latest `npm run verify:governance`, `npm run verify:security`,
  `npm run verify:dr`, and `npm run verify:monitor` results;
- location of encrypted database and storage backups;
- process for handling correction, export, restriction, and deletion requests.

