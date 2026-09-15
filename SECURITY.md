# SPMS Security Policy

## Secret Handling

- Browser code may contain only public credentials such as the Supabase anon key
  and Paystack public key.
- Private credentials must never be committed:
  `PAYSTACK_SECRET_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `RESEND_API_KEY`,
  `REPORT_CRON_SECRET`, Cloudflare API tokens, and database passwords.
- Real owner deployment values belong in local `.env` files or Supabase Edge
  Function secrets. Use `.env.production.example` only as a placeholder template.

## Payment Safety

- The browser must not create Paystack transactions directly.
- Clearance and repository download payments must be initialized and verified by
  Edge Functions using `PAYSTACK_SECRET_KEY`.
- Payment records should include server-verified status, reference, transaction
  type, and split accounting metadata.
- Replaying a successful repository reference must return the existing unlock
  or guest order and never create a second payment record or charge.

## Data Access

- Supabase Row Level Security must stay enabled for profile, payment, workflow,
  notification, report, audit, and tenant tables.
- Private storage buckets must stay private. Thesis PDFs, watermarked downloads,
  and generated reports should be accessed through policy-controlled reads or
  short-lived signed URLs.
- Public endpoints must return only controlled public verification/catalog data.
- Public catalog reads must include the resolved institution identifier; when
  tenant resolution fails, the browser must not issue an unscoped catalog query.
- Data classification, retention, access reviews, data subject requests, and
  public/private catalog boundaries are maintained in
  `docs/data-governance-privacy-runbook.md`.

## Edge Functions

- Browser-callable functions use `verify_jwt = false` only so CORS preflight
  requests can succeed; functions must validate auth or a cron secret inside the
  function body.
- The repository function's two public guest actions are the documented
  exception: they validate the project, email format, Paystack amount,
  transaction metadata, and paid customer email before issuing a short-lived
  watermarked link. They never expose the original storage path.
- Public verification may be unauthenticated, but it must not return private file
  paths, storage object names, or secret metadata.
- Scheduled report cron execution must require `REPORT_CRON_SECRET`.

## Reporting Vulnerabilities

Report suspected vulnerabilities privately to the project owner. Include:

- Affected URL, function, table, or file.
- Steps to reproduce.
- Expected impact.
- Any logs or screenshots that do not expose private student data or secrets.

Do not publish vulnerabilities, real keys, student records, or private PDFs in
public issues or chat threads.

## Verification

Run these checks before handover:

```bash
npm run verify:security
npm run verify:governance
npm run verify:release
npm run verify:lifecycle
```
