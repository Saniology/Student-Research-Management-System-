#!/usr/bin/env bash
set -euo pipefail

PROJECT_REF="tejkksgyqltudpfuzjdo"
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

cd "$ROOT_DIR"

if [[ -f ".env.production.local" ]]; then
  echo "Loading owner deployment env from .env.production.local..."
  set -a
  # shellcheck disable=SC1091
  source ".env.production.local"
  set +a
fi

if [[ -n "${SUPABASE_CLI:-}" ]]; then
  read -r -a SUPABASE_CMD <<< "$SUPABASE_CLI"
elif command -v supabase >/dev/null 2>&1; then
  SUPABASE_CMD=(supabase)
elif command -v npx >/dev/null 2>&1; then
  SUPABASE_CMD=(npx --yes supabase)
else
  echo "Install Supabase CLI or Node/npm first:"
  echo "  npm install -g supabase"
  echo "  or use npx through the bundled deploy script"
  exit 1
fi

if [[ -z "${PAYSTACK_SECRET_KEY:-}" ]]; then
  echo "Set your Paystack secret key before deploying:"
  echo "  export PAYSTACK_SECRET_KEY=sk_test_..."
  exit 1
fi

echo "Linking project ${PROJECT_REF}..."
"${SUPABASE_CMD[@]}" link --project-ref "$PROJECT_REF"

echo "Setting Paystack secret..."
"${SUPABASE_CMD[@]}" secrets set "PAYSTACK_SECRET_KEY=${PAYSTACK_SECRET_KEY}"

if [[ -n "${REPORT_CRON_SECRET:-}" ]]; then
  echo "Setting scheduled report cron secret..."
  "${SUPABASE_CMD[@]}" secrets set "REPORT_CRON_SECRET=${REPORT_CRON_SECRET}"
else
  echo "REPORT_CRON_SECRET not set; admins can still run scheduled reports manually from the app."
fi

if [[ -n "${HEALTH_CHECK_SECRET:-}" ]]; then
  echo "Setting health check secret..."
  "${SUPABASE_CMD[@]}" secrets set "HEALTH_CHECK_SECRET=${HEALTH_CHECK_SECRET}"
else
  echo "HEALTH_CHECK_SECRET not set; health-check will return detailed checks publicly."
fi

if [[ -n "${RESEND_API_KEY:-}" && -n "${REPORT_FROM_EMAIL:-}" ]]; then
  echo "Setting scheduled report email secrets..."
  "${SUPABASE_CMD[@]}" secrets set "RESEND_API_KEY=${RESEND_API_KEY}" "REPORT_FROM_EMAIL=${REPORT_FROM_EMAIL}"
else
  echo "Report email delivery secrets not set; generated reports will stay downloadable in the app."
fi

if [[ -n "${REPORT_DELIVERY_EMAILS:-}" ]]; then
  echo "Setting default scheduled report recipients..."
  "${SUPABASE_CMD[@]}" secrets set "REPORT_DELIVERY_EMAILS=${REPORT_DELIVERY_EMAILS}"
fi

if [[ -n "${REPORT_LINK_TTL_SECONDS:-}" ]]; then
  echo "Setting scheduled report link TTL..."
  "${SUPABASE_CMD[@]}" secrets set "REPORT_LINK_TTL_SECONDS=${REPORT_LINK_TTL_SECONDS}"
fi

echo "Deploying SPMS edge functions..."
"${SUPABASE_CMD[@]}" functions deploy verify-paystack project-workflow repository-access verification-lookup scheduled-reports health-check --no-verify-jwt --use-api

echo "Done. Test with:"
echo "  curl -i -X OPTIONS \"https://${PROJECT_REF}.supabase.co/functions/v1/verify-paystack\""
echo "  curl -i -X OPTIONS \"https://${PROJECT_REF}.supabase.co/functions/v1/project-workflow\""
echo "  curl -i -X OPTIONS \"https://${PROJECT_REF}.supabase.co/functions/v1/repository-access\""
echo "  curl -i -X OPTIONS \"https://${PROJECT_REF}.supabase.co/functions/v1/verification-lookup\""
echo "  curl -i -X OPTIONS \"https://${PROJECT_REF}.supabase.co/functions/v1/scheduled-reports\""
echo "  curl -i -X OPTIONS \"https://${PROJECT_REF}.supabase.co/functions/v1/health-check\""
echo "  curl -i \"https://${PROJECT_REF}.supabase.co/functions/v1/health-check\""
