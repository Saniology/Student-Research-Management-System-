# SPMS Local Development Setup

Use this guide when setting up the Student Project Management System on another
developer machine.

For production deployment, tenant domains, and owner handover checks, see
`docs/production-deployment-runbook.md`.

For owner deployment variables, copy `.env.production.example` to
`.env.production.local` and fill real secrets locally. Do not commit real `.env`
files.

## What Your Colleague Needs

- Git.
- A modern browser.
- Node.js 20 or newer, used for the project verification command.
- Google Chrome or Chromium, used for rendered desktop/mobile UI checks.
- Python 3, used only to serve the static app locally.
- `curl` and `unzip`, used by the project-local Deno install command.
- Internet access, because the app talks to the hosted Supabase project, Paystack,
  and CDN libraries.
- Deno, only if they want to type-check Supabase Edge Functions locally.
- Supabase CLI, only if they are invited to the Supabase project and will deploy
  database or Edge Function changes.

They do not need to run `npx supabase login` just to use the app locally when the
owner has already deployed the database schema and Edge Functions.

## Fast Local Setup

From a fresh machine:

```bash
git clone <project-repository-url>
cd Student-Research-Management-System-
python3 -m http.server 5500 --bind 0.0.0.0
```

Open:

```text
http://127.0.0.1:5500/
```

For normal frontend testing, that is enough after the owner has deployed the
Supabase schema and Edge Functions.

## Owner-Only Supabase Work

The Supabase project is owned by the account connected to:

```text
tejkksgyqltudpfuzjdo
```

Only the owner, or a teammate invited to the Supabase project, should run these:

```bash
npx supabase link --project-ref tejkksgyqltudpfuzjdo
npx supabase secrets set PAYSTACK_SECRET_KEY=sk_test_or_live_key
npx supabase secrets set REPORT_CRON_SECRET=long_random_value
npx supabase secrets set HEALTH_CHECK_SECRET=long_random_value
npx supabase secrets set RESEND_API_KEY=re_xxxxx REPORT_FROM_EMAIL=reports@example.edu
npx supabase secrets set REPORT_DELIVERY_EMAILS=registry@example.edu,finance@example.edu
npx supabase secrets set REPORT_LINK_TTL_SECONDS=604800
bash supabase/deploy-verify-paystack.sh
```

The deploy script loads owner-only values from `.env.production.local`, uses a
global `supabase` CLI when one is installed, and otherwise falls back to
`npx --yes supabase`.

The owner must also apply the SQL files in this order when setting up or
upgrading the hosted database:

```text
supabase/schema.sql
supabase/payments.sql
supabase/secure-payments.sql
supabase/spms-core.sql
```

Never commit or share the Paystack secret key. The browser only uses the Paystack
public key from `js/config.js`.

`REPORT_CRON_SECRET` is optional. Use it when an external cron service will call
the scheduled report endpoint. Admin users can still run reports manually from
the dashboard without that secret.

`RESEND_API_KEY`, `REPORT_FROM_EMAIL`, `REPORT_DELIVERY_EMAILS`, and
`REPORT_LINK_TTL_SECONDS` are optional. Use them only when scheduled report files
should be delivered by email. Without those secrets, generated reports still
appear in Admin > Reports and can be downloaded by admins.

## Run The App Locally

From the project root:

```bash
python3 -m http.server 5500 --bind 0.0.0.0
```

Open:

```text
http://127.0.0.1:5500/
```

If another app is already using port `5500`, use another port:

```bash
python3 -m http.server 5501 --bind 0.0.0.0
```

Then open:

```text
http://127.0.0.1:5501/
```

## Tenant Selection

The app is multi-tenant ready. It resolves the active institution in this order:

- `?tenant=slug` or `?institution=slug` in the URL.
- `window.SPMS_TENANT_SLUG` or `window.SPMS_DEFAULT_TENANT_SLUG` in `js/config.js`.
- The current hostname matched against `institutions.allowed_domains`.
- Fallback to `kasu`.

Examples:

```text
http://127.0.0.1:5500/?tenant=kasu
```

Admins can update the tenant slug and allowed domains from Admin Settings after
`supabase/spms-core.sql` has been applied.

For Cloudflare DNS provisioning, the owner can preview a tenant domain record:

```bash
npm run dns:cloudflare -- --hostname spms.school.edu --target cname.hosting-provider.example --tenant kasu --dry-run
```

Live DNS changes require `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ZONE_ID`, and
`SPMS_DNS_TARGET`; see the production runbook.

## Configuration File

Confirm `js/config.js` contains:

```js
window.SUPABASE_URL = 'https://tejkksgyqltudpfuzjdo.supabase.co';
window.SUPABASE_ANON_KEY = '...';
window.SPMS_DEFAULT_TENANT_SLUG = 'kasu';
window.PAYSTACK_PUBLIC_KEY = 'pk_test_or_live_key'; // optional legacy fallback only
```

The Supabase anon key can be used in the browser. Current payment checkout is
initialized by Supabase Edge Functions and resumed in the browser with Paystack
Inline, so the Paystack secret key is the important payment credential. The
Supabase service role key and Paystack secret key must stay private and belong
only in Supabase Edge Function secrets.

The app validates this browser config at startup. If `SUPABASE_URL`,
`SUPABASE_ANON_KEY`, or the Supabase JS CDN are missing, the page shows a
configuration banner and disables connected login/payment features instead of
failing silently.

## Install Deno For Function Checks

The app can run without Deno. Install Deno when working on files under
`supabase/functions`. The repository download Edge Function imports
`pdf-lib@1.17.1` from `esm.sh` so it can generate watermarked PDF downloads,
and the verification function imports `qrcode-generator@2.0.4` for
server-rendered QR SVG assets. The first Deno check needs internet access to
download and cache those dependencies.

Project-local install, matching the current development setup:

```bash
mkdir -p .deno/bin
curl -L -o /tmp/deno-x86_64-unknown-linux-gnu.zip https://github.com/denoland/deno/releases/latest/download/deno-x86_64-unknown-linux-gnu.zip
unzip -o /tmp/deno-x86_64-unknown-linux-gnu.zip -d .deno/bin
.deno/bin/deno --version
```

`.deno/` is ignored by Git, so each developer installs it locally on their own
machine.

Run Edge Function checks:

```bash
.deno/bin/deno check supabase/functions/verify-paystack/index.ts
.deno/bin/deno check supabase/functions/repository-access/index.ts
.deno/bin/deno check supabase/functions/project-workflow/index.ts supabase/functions/verification-lookup/index.ts supabase/functions/scheduled-reports/index.ts
```

## Smoke Tests

Run the full lifecycle verifier:

```bash
npm run verify:lifecycle
```

This checks the static HTML script, Supabase Edge Function TypeScript, deployment
script syntax, important schema/function capabilities, UI smoke coverage, and
whether the local server is responding. The server check is reported as a warning
when the app is not running.

For a quick UI-only check:

```bash
npm run verify:a11y
npm run verify:ui
```

These catch accessibility regressions, broken inline buttons, missing role
dashboard surfaces, duplicate HTML ids, and small admin layout issues.

For owner handover/release readiness:

```bash
npm run verify:db
npm run verify:edge
npm run verify:email
npm run verify:security
npm run verify:workflow
npm run verify:release
```

These checks cover database schema contracts, Edge Function CORS/action/error
contracts, email deliverability handover, security posture, workflow contracts,
the production env template, release checklist, and obvious private secret leaks
in release-facing files.

With the local server running, check actual browser rendering:

```bash
npm run verify:render
npm run verify:roles
npm run verify:interactions
```

This captures desktop and mobile screenshots with Chrome/Chromium, then opens
local-only role previews for student, supervisor, library, and admin dashboards.
The role previews are available only from local hosts through
`?preview_role=student`, `?preview_role=teacher`, `?preview_role=library`, or
`?preview_role=admin`.
`npm run verify:interactions` also opens local preview workflow states such as
the supervisor review modal, library catalog modal, student receipt state, and
admin reports section.

GitHub Actions runs the same rendered UI, role rendering, role interaction, and
full lifecycle verifiers on pushes and pull requests. Keep the local server
command working because CI uses the same static serving path.

Check the static app:

```bash
curl -I http://127.0.0.1:5500/
```

Expected result:

```text
HTTP/1.0 200 OK
```

Check deployed Edge Function CORS:

```bash
npm run verify:deploy
```

This checks all Supabase Edge Function preflight routes and the `health-check`
endpoint using `SUPABASE_URL` from `.env.production.local` or `js/config.js`.
The owner should run it after deploying functions. A colleague who cannot log in
to Supabase can still run this command because it only calls public function
URLs; detailed health output needs `HEALTH_CHECK_SECRET` in their local env file.

Manual equivalent:

```bash
curl -i -X OPTIONS "https://tejkksgyqltudpfuzjdo.supabase.co/functions/v1/verify-paystack"
curl -i -X OPTIONS "https://tejkksgyqltudpfuzjdo.supabase.co/functions/v1/repository-access"
curl -i -X OPTIONS "https://tejkksgyqltudpfuzjdo.supabase.co/functions/v1/scheduled-reports"
curl -i -X OPTIONS "https://tejkksgyqltudpfuzjdo.supabase.co/functions/v1/health-check"
```

Expected result after owner deployment:

```text
HTTP 204
```

If the response is `404 Requested function was not found`, the owner needs to
deploy the Edge Functions. If the browser shows a CORS preflight error, check the
same `OPTIONS` commands first because a missing function often appears as a CORS
failure in the browser.

Check deployed health:

```bash
curl -i "https://tejkksgyqltudpfuzjdo.supabase.co/functions/v1/health-check"
```

When `HEALTH_CHECK_SECRET` is configured, pass `x-health-secret` to see detailed
database and storage checks.

## Scheduled Reports

Admins can create schedules and generate reports from Admin > Reports after
`supabase/spms-core.sql` and `scheduled-reports` are deployed.

Each schedule can include one or more recipient emails in the dashboard. If a
schedule has no recipients, the function falls back to `REPORT_DELIVERY_EMAILS`
when that secret exists.

Email delivery uses Resend when `RESEND_API_KEY` and `REPORT_FROM_EMAIL` are set.
The emailed download link is a private Supabase signed URL. By default it expires
after 604800 seconds, which is 7 days; override that with
`REPORT_LINK_TTL_SECONDS`.

For server-side cron, the owner should set `REPORT_CRON_SECRET`, then call:

```bash
curl -i -X POST "https://tejkksgyqltudpfuzjdo.supabase.co/functions/v1/scheduled-reports" \
  -H "x-cron-secret: $REPORT_CRON_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"action":"run_due"}'
```

A colleague who is not logged into Supabase does not need to run this command.
It is for the owner or production scheduler only.

## Current Local Tooling Installed By Codex

On the current machine, Codex installed:

```text
.deno/bin/deno
deno 2.9.5
```

No global `sudo` installation was performed.
