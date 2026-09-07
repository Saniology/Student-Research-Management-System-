const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-api-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  try {
    const body = await req.json();
    const matric = normalizeString(body.matric).toUpperCase();
    const email = normalizeString(body.email).toLowerCase();
    const requestedName = normalizeString(body.full_name);
    const requestedDepartment = normalizeString(body.department);
    const tenantSlug = normalizeString(body.tenant_slug) || "kasu";
    if (!matric || !email || !/^\S+@\S+\.\S+$/.test(email)) {
      return jsonResponse({ error: "A valid matric number and school email are required" }, 400);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    if (!supabaseUrl || !serviceRoleKey) return jsonResponse({ error: "Identity service is not configured" }, 500);

    const [institution] = await supabaseRest(
      supabaseUrl,
      serviceRoleKey,
      `/institutions?slug=eq.${encodeURIComponent(tenantSlug)}&select=id,allowed_domains`,
    );
    if (!institution) return jsonResponse({ error: "Institution was not found" }, 404);

    const domain = email.split("@")[1] || "";
    const allowedDomains = Array.isArray(institution.allowed_domains)
      ? institution.allowed_domains.map((value: unknown) => String(value).toLowerCase()).filter((value: string) => !value.includes(".local"))
      : [];
    if (allowedDomains.length && !allowedDomains.includes(domain)) {
      return jsonResponse({ error: `Use your school email (${allowedDomains.join(" or ")})` }, 403);
    }

    const existingAccounts = await lookupExistingAccounts(supabaseUrl, serviceRoleKey, matric, email);
    if (existingAccounts.length) {
      return jsonResponse({ error: "A student account already exists for this matric number or email. Sign in instead." }, 409);
    }

    const sisRecord = await lookupSis(matric, email);
    const registry = sisRecord || (await lookupRegistry(supabaseUrl, serviceRoleKey, institution.id, matric));
    const fullName = requestedName || normalizeString(registry?.full_name);
    const department = requestedDepartment || normalizeString(registry?.department);
    if (!fullName || !department) {
      return jsonResponse({ error: "Full name and department are required for student registration" }, 400);
    }

    return jsonResponse({
      success: true,
      source: sisRecord ? "sis" : registry ? "registry" : "self_reported",
      student: {
        matric,
        full_name: fullName,
        department,
        department_id: normalizeString(registry?.department_id),
        course_id: normalizeString(registry?.course_id),
        supervisor_email: normalizeString(registry?.supervisor_email),
        degree: normalizeString(registry?.degree) || "BSc",
        avatar_url: normalizeString(registry?.avatar_url),
      },
    });
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : "Identity lookup failed" }, 500);
  }
});

async function lookupSis(matric: string, email: string) {
  const baseUrl = Deno.env.get("SIS_API_URL");
  if (!baseUrl) return null;
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/students/lookup`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(Deno.env.get("SIS_API_TOKEN") ? { Authorization: `Bearer ${Deno.env.get("SIS_API_TOKEN")}` } : {}),
    },
    body: JSON.stringify({ matric, email }),
  });
  if (!response.ok) return null;
  const payload = await response.json();
  return payload?.student || payload?.data || payload || null;
}

async function lookupRegistry(supabaseUrl: string, serviceRoleKey: string, institutionId: string, matric: string) {
  const records = await supabaseRest(
    supabaseUrl,
    serviceRoleKey,
    `/students_registry?institution_id=eq.${encodeURIComponent(institutionId)}&matric=eq.${encodeURIComponent(matric)}&select=matric,full_name,department,department_id,course_id,supervisor_email,degree,avatar_url`,
  );
  return records[0] || null;
}

async function lookupExistingAccounts(supabaseUrl: string, serviceRoleKey: string, matric: string, email: string) {
  return await supabaseRest(
    supabaseUrl,
    serviceRoleKey,
    `/profiles?or=(matric.eq.${encodeURIComponent(matric)},email.eq.${encodeURIComponent(email)})&select=id&limit=1`,
  );
}

async function supabaseRest(supabaseUrl: string, serviceRoleKey: string, path: string) {
  const response = await fetch(`${supabaseUrl}/rest/v1${path}`, {
    headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` },
  });
  if (!response.ok) throw new Error(`Identity lookup database request failed (${response.status})`);
  return await response.json();
}

function normalizeString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
