# SPMS Production Deployment Runbook

Use this checklist when preparing SPMS for a real institution.

For the final handover gate, also use `docs/release-checklist.md`.

For scheduled report email delivery, also use
`docs/production-email-deliverability.md` before setting live sender secrets.

## 1. Database

Apply SQL in this order from the Supabase SQL Editor:

```text
supabase/schema.sql
supabase/payments.sql
supabase/secure-payments.sql
supabase/spms-core.sql
```

Rerunning `spms-core.sql` is safe for upgrades. It creates tenant settings,
workflow tables, report automation tables, storage buckets, indexes, and RLS
policies.

## 2. Function Secrets

Required:

```bash
supabase secrets set PAYSTACK_SECRET_KEY=sk_live_or_test_key
```

Optional but recommended for production operations:

```bash
supabase secrets set REPORT_CRON_SECRET=long_random_value
supabase secrets set HEALTH_CHECK_SECRET=long_random_value
supabase secrets set RESEND_API_KEY=re_xxxxx REPORT_FROM_EMAIL=reports@example.edu
supabase secrets set REPORT_DELIVERY_EMAILS=registry@example.edu,finance@example.edu
supabase secrets set REPORT_LINK_TTL_SECONDS=604800
```

Keep service role keys, Paystack secret keys, and email provider tokens out of
browser code and out of Git.

Use `.env.production.example` as the owner-only template for local deployment
environment variables. Copy it to `.env.production.local` and fill real values
there.

The deploy script automatically loads `.env.production.local`. It uses a global
`supabase` CLI when installed, otherwise it falls back to `npx --yes supabase`.
Set `SUPABASE_CLI` only when you need a custom command path.

## 3. Edge Functions

Deploy all functions:

```bash
bash supabase/deploy-verify-paystack.sh
```

Confirm CORS preflight returns `HTTP 204`:

```bash
npm run verify:deploy
```

The verifier checks every deployed Edge Function preflight route, detects
`NOT_FOUND`, validates CORS headers, and calls `health-check`. It reads
`SUPABASE_URL` from `.env.production.local` or `js/config.js`. Add
`HEALTH_CHECK_SECRET` to `.env.production.local` when detailed health checks are
protected.

Manual equivalent:

```bash
curl -i -X OPTIONS "https://tejkksgyqltudpfuzjdo.supabase.co/functions/v1/verify-paystack"
curl -i -X OPTIONS "https://tejkksgyqltudpfuzjdo.supabase.co/functions/v1/project-workflow"
curl -i -X OPTIONS "https://tejkksgyqltudpfuzjdo.supabase.co/functions/v1/repository-access"
curl -i -X OPTIONS "https://tejkksgyqltudpfuzjdo.supabase.co/functions/v1/verification-lookup"
curl -i -X OPTIONS "https://tejkksgyqltudpfuzjdo.supabase.co/functions/v1/scheduled-reports"
curl -i -X OPTIONS "https://tejkksgyqltudpfuzjdo.supabase.co/functions/v1/health-check"
```

## 4. Health Checks

The `health-check` function verifies function environment, database reachability,
and required private storage buckets. If `HEALTH_CHECK_SECRET` is set, public
callers only receive a high-level status and monitoring tools can request details
with the secret header.

```bash
curl -i "https://tejkksgyqltudpfuzjdo.supabase.co/functions/v1/health-check"
curl -i "https://tejkksgyqltudpfuzjdo.supabase.co/functions/v1/health-check" \
  -H "x-health-secret: $HEALTH_CHECK_SECRET"
```

Expected healthy status:

```json
{"service":"spms","status":"ok"}
```

## 5. Tenant Domains

SPMS resolves an institution by URL tenant slug, configured default slug, or a
custom hostname saved in `institutions.allowed_domains`.

For Cloudflare-managed DNS, preview a record:

```bash
npm run dns:cloudflare -- --hostname spms.school.edu --target cname.hosting-provider.example --tenant kasu --dry-run
```

For live Cloudflare changes:

```bash
export CLOUDFLARE_API_TOKEN=...
export CLOUDFLARE_ZONE_ID=...
export SPMS_DNS_TARGET=cname.hosting-provider.example
npm run dns:cloudflare -- --hostname spms.school.edu --tenant kasu
```

Then add the hostname in Admin Settings > Allowed Domains, or run the SQL shown
by the script. The script only creates or updates the DNS record; the tenant
mapping still belongs in Supabase so SPMS knows which institution to load.

## 6. Scheduled Reports

Admins can create schedules from Admin > Reports. Generated files are stored in
the private `reports` bucket. When email secrets are configured, recipients get a
private signed download link.

Before setting live email secrets, authenticate the sending domain and complete
`docs/production-email-deliverability.md`.

External cron can run due schedules:

```bash
curl -i -X POST "https://tejkksgyqltudpfuzjdo.supabase.co/functions/v1/scheduled-reports" \
  -H "x-cron-secret: $REPORT_CRON_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"action":"run_due"}'
```

## 7. Verification

Before handing over:

```bash
npm run verify:a11y
npm run verify:config
npm run verify:db
npm run verify:edge
npm run verify:email
npm run verify:deploy
npm run verify:security
npm run verify:ui
npm run verify:workflow
npm run verify:release
npm run verify:lifecycle
```

Expected result:

```text
Accessibility verification complete: 0 failure(s).
Browser config verification complete: 0 failure(s).
Database schema verification complete: 0 failure(s).
Edge Function contract verification complete: 0 failure(s).
Email deliverability verification complete: 0 failure(s).
Security verification complete: 0 failure(s).
Workflow contract verification complete: 0 failure(s).
Release readiness verification complete: 0 failure(s).
Verification complete: 0 failure(s), 0 warning(s).
```
