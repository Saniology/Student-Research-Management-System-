# SPMS Production Email Deliverability

Use this runbook before enabling scheduled report email delivery for an
institution. Email delivery is optional; when it is not configured, reports still
generate into the private `reports` bucket and admins can download them from the
dashboard.

## 1. Sending Identity

- Use a dedicated sender such as `reports@institution.edu.ng`.
- Keep `REPORT_FROM_EMAIL` on the same authenticated domain used by the email
  provider.
- Keep real `RESEND_API_KEY` values in Supabase Edge Function secrets or local
  owner-only `.env` files. Never put them in `js/config.js` or committed docs.

## 2. DNS Authentication

Before enabling live delivery, authenticate the sender domain with the email
provider and confirm these DNS records are valid:

- SPF authorizes the provider to send for the domain.
- DKIM is verified for cryptographic message signing.
- DMARC exists for the organizational domain.
- The visible From domain aligns with SPF/DKIM/DMARC results.

Start DMARC at monitoring mode, for example `p=none`, then move toward stricter
policy after production mail is stable.

## 3. Supabase Secrets

Set these only after DNS authentication is verified:

```bash
supabase secrets set RESEND_API_KEY=re_xxxxx REPORT_FROM_EMAIL=reports@institution.edu.ng
supabase secrets set REPORT_DELIVERY_EMAILS=registry@institution.edu.ng,finance@institution.edu.ng
supabase secrets set REPORT_LINK_TTL_SECONDS=604800
```

The `scheduled-reports` function sends private signed report links. It does not
attach raw report files to email.

## 4. Test Send

After deployment, run a one-off report as an admin:

```bash
curl -i -X POST "https://tejkksgyqltudpfuzjdo.supabase.co/functions/v1/scheduled-reports" \
  -H "Authorization: Bearer $SUPABASE_USER_JWT" \
  -H "Content-Type: application/json" \
  -d '{"action":"run_once","report_type":"student_register","email_recipients":["registry@institution.edu.ng"]}'
```

Confirm:

- The response includes `delivery.status` as `sent`.
- The recipient receives the email in the inbox, not spam.
- The download link opens only as a signed private URL.
- The generated report also appears in Admin > Reports.

## 5. Monitoring

During the first production week, monitor:

- Delivery failures from the email provider.
- Bounces and complaints.
- Suppression list entries.
- DMARC aggregate reports.
- Unexpected recipient addresses in report schedules.

If delivery quality drops, remove or pause `RESEND_API_KEY` and
`REPORT_FROM_EMAIL`. Report generation will continue, but email delivery will
return `email_provider_not_configured` and skip sending.

## 6. Release Gate

Before handover, run:

```bash
npm run verify:email
npm run verify:release
```

Then confirm the institution owner has completed the real provider-side DNS and
mailbox checks above.
