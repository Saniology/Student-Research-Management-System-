#!/usr/bin/env bash
set -euo pipefail

PROJECT_REF="tejkksgyqltudpfuzjdo"
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

if ! command -v supabase >/dev/null 2>&1; then
  echo "Install Supabase CLI first: https://supabase.com/docs/guides/cli"
  exit 1
fi

if [[ -z "${PAYSTACK_SECRET_KEY:-}" ]]; then
  echo "Set your Paystack secret key before deploying:"
  echo "  export PAYSTACK_SECRET_KEY=sk_test_..."
  exit 1
fi

cd "$ROOT_DIR"

echo "Linking project ${PROJECT_REF}..."
supabase link --project-ref "$PROJECT_REF"

echo "Setting Paystack secret..."
supabase secrets set "PAYSTACK_SECRET_KEY=${PAYSTACK_SECRET_KEY}"

echo "Deploying verify-paystack..."
supabase functions deploy verify-paystack --no-verify-jwt --use-api

echo "Done. Test with:"
echo "  curl -i -X OPTIONS \"https://${PROJECT_REF}.supabase.co/functions/v1/verify-paystack\""
