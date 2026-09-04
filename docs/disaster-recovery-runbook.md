# SPMS Disaster Recovery Runbook

Use this runbook before production handover and during every recovery drill. It
covers the data that matters most to SPMS: student profiles, submissions,
payments, project workflow, receipts, public catalog metadata, generated
reports, and private PDFs.

## Recovery Targets

- Recovery point objective (RPO): no more than 24 hours of database data loss
  for normal production operation.
- Recovery time objective (RTO): restore a usable read-only institutional
  portal within 4 hours, then restore write workflows after verification.
- Monthly restore drill: restore database and storage samples into a non-prod
  Supabase project and run the verification commands below.
- Incident owner: the institution system administrator or SPMS operations lead.

## Backup Scope

- PostgreSQL data: auth-linked `profiles`, `students_registry`, `payments`,
  `submissions`, `projects`, reviews, catalog, receipts, notifications, reports,
  audit logs, institutions, academic hierarchy, and tenant settings.
- Storage buckets: `thesis-pdfs`, `repository-downloads`, and `reports`.
- Edge Function configuration: deployed source, `supabase/config.toml`, and
  owner-only secrets stored in Supabase.
- Frontend configuration: `js/config.js`, tenant domains, DNS records, and
  `.env.production.local` on the owner machine.

## Database Backup

Use Supabase platform backups where available for the project plan. For
owner-managed exports, run a logical backup from a secured machine:

```bash
pg_dump "$SUPABASE_DB_URL" \
  --format=custom \
  --no-owner \
  --no-privileges \
  --file "spms-$(date +%F).dump"
```

Store backups in encrypted storage controlled by the institution. Keep at least:

- 7 daily restore points.
- 4 weekly restore points.
- 12 monthly restore points.

Never commit database URLs, service role keys, Paystack secrets, backup dumps, or
exported CSVs to Git.

## Storage Backup

Back up private storage buckets on the same schedule as the database:

- `thesis-pdfs`: original private student PDF uploads.
- `repository-downloads`: generated watermarked copies, safe to rebuild if
  originals and unlock records are intact.
- `reports`: generated report CSV artifacts.

Use Supabase dashboard exports, storage API scripts, or provider-native object
storage replication. Validate a sample from each bucket monthly:

- One thesis PDF opens from `thesis-pdfs`.
- One watermarked repository copy opens from `repository-downloads`.
- One generated report opens from `reports`.

## Restore Drill

Perform restore drills only in a non-production Supabase project.

1. Create a fresh non-prod Supabase project.
2. Apply SQL in order:
   `schema.sql`, `payments.sql`, `secure-payments.sql`, `spms-core.sql`.
3. Restore the latest database dump.
4. Restore a sample from each private storage bucket.
5. Deploy Edge Functions with non-prod secrets.
6. Point `js/config.js` at the drill project.
7. Run:

```bash
npm run verify:config
npm run verify:db
npm run verify:edge
npm run verify:security
npm run verify:workflow
npm run verify:lifecycle
```

8. Run `npm run verify:deploy` against the drill project after deployment.
9. Sign in as each role and confirm student upload, supervisor review, library
   publish, admin reports, public receipt verification, and paid repository
   download behavior.

## Recovery Validation

After any production restore:

- Confirm `health-check` returns `status: ok`.
- Confirm every Edge Function preflight route returns HTTP 204.
- Confirm RLS is enabled on workflow, payment, report, and notification tables.
- Confirm private buckets remain private.
- Confirm Paystack transactions are not duplicated during retry recovery.
- Confirm issued receipt verification codes still resolve.
- Confirm published public catalog records do not expose private file paths.
- Confirm generated reports use signed private links.

## Incident Response

- Freeze writes by disabling public app access or routing users to a maintenance
  page.
- Preserve logs, audit records, and the last known backup metadata.
- Restore into non-prod first when time allows.
- Compare record counts for payments, projects, receipts, public catalog, and
  generated reports before reopening writes.
- Rotate secrets after suspected credential exposure.
- Document incident timeline, data loss window, root cause, and prevention work.

## Handover Evidence

Before final handover, the owner should keep:

- Last successful database backup timestamp.
- Last successful storage backup timestamp.
- Last restore drill date and environment.
- Person responsible for monthly restore drills.
- Location of encrypted backup storage.
- Confirmation that service role keys and payment secrets are not in Git.
