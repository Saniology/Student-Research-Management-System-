# SPMS Production Monitoring Runbook

Use this runbook after deployment and before institutional handover. Monitoring
must prove that users can reach the portal, payments can complete, private
storage is healthy, reports can run, and incidents reach the right people.

## Monitoring Targets

- Uptime target: 99.5% monthly availability for the public portal and critical
  Edge Functions.
- Alert acknowledgement target: 15 minutes during working hours.
- Payment incident response target: 30 minutes for failed clearance or repository
  payment verification.
- Report delivery incident response target: next business day unless statutory
  reporting is due sooner.

## Required Monitors

- Public portal uptime: load the production hostname and expect HTTP 200.
- Supabase Edge Function preflight: run `npm run verify:deploy` or equivalent
  `OPTIONS` checks for every function.
- Detailed health endpoint: call `health-check` with `x-health-secret` and alert
  when status is not `ok`.
- Database health: use `health-check` database status and Supabase dashboard
  metrics for connection errors, slow queries, and high error rates.
- Storage health: use `health-check` bucket status for `thesis-pdfs`,
  `repository-downloads`, and `reports`.
- Scheduled reports: monitor the external cron call to `scheduled-reports` and
  alert on non-2xx responses.
- Payments: review failed Paystack verification, retry verification, duplicate
  reference errors, and repository unlock failures.
- Email delivery: monitor bounces, complaints, suppression list changes, and
  DMARC aggregate reports as described in
  `docs/production-email-deliverability.md`.

## Recommended Checks

Run these from an uptime provider, server cron, or owner machine:

```bash
curl -fsS "https://institution.example.edu" >/dev/null
npm run verify:deploy
curl -fsS "https://tejkksgyqltudpfuzjdo.supabase.co/functions/v1/health-check" \
  -H "x-health-secret: $HEALTH_CHECK_SECRET"
curl -fsS -X POST "https://tejkksgyqltudpfuzjdo.supabase.co/functions/v1/scheduled-reports" \
  -H "x-cron-secret: $REPORT_CRON_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"action":"run_due"}'
```

Do not put `HEALTH_CHECK_SECRET`, `REPORT_CRON_SECRET`, service role keys, or
Paystack secrets into public uptime monitors that expose request details.

## Alert Routing

- Primary: institution system administrator.
- Secondary: SPMS operations lead.
- Finance/payment alerts: finance officer plus SPMS operations lead.
- Library/catalog alerts: library system owner plus SPMS operations lead.
- Email deliverability alerts: domain/DNS owner plus SPMS operations lead.

Every alert route must include owner name, phone/email, escalation order, and
quiet-hours handling before production handover.

## Incident Evidence

For every production incident, capture:

- Start time, detection source, acknowledgement time, and resolution time.
- Affected tenant, role, payment/reference/project/report identifiers when
  relevant.
- `health-check` output, Supabase logs, Edge Function response code, and browser
  console/network error when available.
- Whether payments, receipts, catalog records, generated reports, or private PDFs
  were affected.
- Follow-up issue and owner.

## Monitoring After Changes

After SQL changes, Edge Function deployment, DNS change, Paystack key rotation,
email sender change, or restore drill:

```bash
npm run verify:config
npm run verify:edge
npm run verify:deploy
npm run verify:security
npm run verify:workflow
```

Then verify:

- `health-check` status is `ok`.
- Login works for each role.
- Clearance payment initialization returns a Paystack access code.
- Repository download payment initialization returns a Paystack access code.
- Public receipt/project verification returns controlled data only.
- Scheduled reports can run and generated report links are signed/private.

## Handover Evidence

Before handover, record:

- Uptime monitor provider and dashboard URL.
- Alert recipients and escalation order.
- `HEALTH_CHECK_SECRET` storage location.
- `REPORT_CRON_SECRET` storage location.
- Last successful `npm run verify:deploy` result.
- Last successful scheduled report cron result.
- Last payment verification retry test.
- Last email deliverability review date.
