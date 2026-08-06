# SPMS Release Checklist

Use this checklist before a production handover or institutional demo.

## Code And Config

- Confirm `js/config.js` points to the intended Supabase project URL and anon key.
- Confirm no private secrets are committed. Real values belong in local `.env`
  files or Supabase Edge Function secrets.
- Copy `.env.production.example` to `.env.production.local` for owner deployment
  work, then fill in real values locally.
- Run `npm run verify:a11y`.
- Run `npm run verify:db`.
- Run `npm run verify:email`.
- Start the local server and run `npm run verify:render`.
- With the local server still running, run `npm run verify:roles`.
- With the local server still running, run `npm run verify:interactions`.
- Run `npm run verify:security`.
- Run `npm run verify:workflow`.
- Run `npm run verify:release`.
- Run `npm run verify:lifecycle`.
- Confirm the GitHub Actions `Verify SPMS` workflow passes on the release branch.

## Database

- Apply SQL in the documented order:
  `schema.sql`, `payments.sql`, `secure-payments.sql`, `spms-core.sql`.
- Confirm `spms-core.sql` completes without SQL Editor errors.
- Confirm storage buckets exist: `thesis-pdfs`, `repository-downloads`,
  `reports`.
- Confirm RLS remains enabled on workflow, payment, report, and notification
  tables.

## Edge Functions

- Set required secret: `PAYSTACK_SECRET_KEY`.
- Set optional operational secrets as needed:
  `REPORT_CRON_SECRET`, `HEALTH_CHECK_SECRET`, `RESEND_API_KEY`, `REPORT_FROM_EMAIL`,
  `REPORT_DELIVERY_EMAILS`, `REPORT_LINK_TTL_SECONDS`.
- Deploy all functions with `bash supabase/deploy-verify-paystack.sh`.
- Run `npm run verify:deploy`.
- Confirm every Edge Function `OPTIONS` request returns `HTTP 204`.
- Confirm `health-check` returns `status: ok` after SQL and bucket setup.

## Payments

- Test a clearance payment in Paystack test mode.
- Test retry verification using the saved reference.
- Test a paid repository download and confirm the returned PDF is watermarked.
- Confirm payment records include transaction type, Paystack reference, status,
  and institution/provider split fields.

## Roles

- Run `npm run verify:roles` to render local student, supervisor, library, and
  admin preview surfaces in Chrome/Chromium.
- Run `npm run verify:interactions` to open the local student receipt state,
  supervisor review modal, library catalog modal, and admin reports section.
- Student: sign up or sign in, upload project metadata and PDF, initialize
  payment, see workflow status.
- Supervisor: load assigned projects, approve one, request revision on one.
- Library: publish an approved project with shelf number and QR payload.
- Admin: review dashboard metrics, payment table, settings, reports, analytics,
  and academic hierarchy controls.

## Reports

- Generate each manual report from Admin > Reports.
- Create a scheduled report.
- Run due reports manually or through cron.
- Download a generated report from the private `reports` bucket.
- If email delivery is enabled, complete `docs/production-email-deliverability.md`.
- Confirm recipients receive signed private links from an authenticated sender
  domain.

## Tenant Domain

- Preview DNS with `npm run dns:cloudflare -- --hostname spms.school.edu --target cname.hosting-provider.example --tenant kasu --dry-run`.
- Apply DNS only after `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ZONE_ID`, and
  `SPMS_DNS_TARGET` are set locally.
- Add the hostname to Admin Settings > Allowed Domains.
- Confirm the custom hostname loads the correct tenant branding.

## Handover

- Share `docs/local-development-setup.md` with collaborators.
- Share `docs/production-deployment-runbook.md` with the project owner/admin.
- Keep Supabase owner credentials, Paystack secret keys, service role keys, and
  DNS provider tokens private.
