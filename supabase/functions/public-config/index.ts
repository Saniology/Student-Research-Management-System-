const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-api-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

const DEFAULT_CONFIG = {
  clearance_fee_kobo: 200_000,
  download_fee_kobo: 50_000,
  max_pdf_size_bytes: 100 * 1024 * 1024,
  allowed_mime_types: ["application/pdf"],
  currency: "NGN",
  receipt_prefix: "KASU-SPMS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    if (!supabaseUrl || !serviceRoleKey) {
      return jsonResponse({ error: "Public configuration service is not configured" }, 500);
    }

    const body = await req.json().catch(() => ({}));
    const institutionId = typeof body.institution_id === "string" ? body.institution_id.trim() : "";
    const slug = typeof body.tenant_slug === "string" && body.tenant_slug.trim()
      ? body.tenant_slug.trim()
      : "kasu";
    const filter = institutionId
      ? `institution_id=eq.${encodeURIComponent(institutionId)}`
      : `institution_id=eq.${encodeURIComponent(await resolveInstitutionId(supabaseUrl, serviceRoleKey, slug))}`;
    const records = await supabaseRest(
      supabaseUrl,
      serviceRoleKey,
      `/system_configs?${filter}&select=institution_id,clearance_fee_kobo,download_fee_kobo,max_pdf_size_bytes,allowed_mime_types,currency,receipt_prefix`,
    );

    return jsonResponse({
      config: normalizeConfig(records[0] || {}, institutionId || null),
    });
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : "Public configuration lookup failed" }, 500);
  }
});

async function resolveInstitutionId(supabaseUrl: string, serviceRoleKey: string, slug: string) {
  const records = await supabaseRest(
    supabaseUrl,
    serviceRoleKey,
    `/institutions?slug=eq.${encodeURIComponent(slug)}&select=id`,
  );
  if (!records[0]?.id) throw new Error("Institution was not found");
  return String(records[0].id);
}

async function supabaseRest(supabaseUrl: string, serviceRoleKey: string, path: string) {
  const response = await fetch(`${supabaseUrl}/rest/v1${path}`, {
    headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` },
  });
  if (!response.ok) throw new Error(`Configuration database request failed (${response.status})`);
  return await response.json();
}

function normalizeConfig(record: Record<string, unknown>, institutionId: string | null) {
  return {
    institution_id: record.institution_id || institutionId,
    clearance_fee_kobo: positiveInteger(record.clearance_fee_kobo, DEFAULT_CONFIG.clearance_fee_kobo),
    download_fee_kobo: positiveInteger(record.download_fee_kobo, DEFAULT_CONFIG.download_fee_kobo),
    max_pdf_size_bytes: positiveInteger(record.max_pdf_size_bytes, DEFAULT_CONFIG.max_pdf_size_bytes),
    allowed_mime_types: Array.isArray(record.allowed_mime_types) && record.allowed_mime_types.length
      ? record.allowed_mime_types.map((value) => String(value))
      : DEFAULT_CONFIG.allowed_mime_types,
    currency: typeof record.currency === "string" && record.currency.trim() ? record.currency.trim() : DEFAULT_CONFIG.currency,
    receipt_prefix: typeof record.receipt_prefix === "string" && record.receipt_prefix.trim()
      ? record.receipt_prefix.trim()
      : DEFAULT_CONFIG.receipt_prefix,
  };
}

function positiveInteger(value: unknown, fallback: number) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
