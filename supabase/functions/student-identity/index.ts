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
    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    if (!supabaseUrl || !serviceRoleKey || !supabaseAnonKey) return jsonResponse({ error: "Identity service is not configured" }, 500);

    if (body.action === "students/sync") {
      const authHeader = req.headers.get("Authorization");
      if (!authHeader) return jsonResponse({ error: "Missing authorization header" }, 401);
      const user = await getAuthenticatedUser(supabaseUrl, supabaseAnonKey, authHeader);
      if (!user) return jsonResponse({ error: "Unauthorized" }, 401);
      return await syncStudentIdentity(supabaseUrl, serviceRoleKey, user);
    }

    const matric = normalizeString(body.matric).toUpperCase();
    const email = normalizeString(body.email).toLowerCase();
    const requestedName = normalizeString(body.full_name);
    const requestedDepartment = normalizeString(body.department);
    const tenantSlug = normalizeString(body.tenant_slug) || "kasu";
    if (!matric || !email || !/^\S+@\S+\.\S+$/.test(email)) {
      return jsonResponse({ error: "A valid matric number and school email are required" }, 400);
    }

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
  try {
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
  } catch (_) {
    // A temporary SIS outage must not prevent the controlled private registry
    // fallback from refreshing a known KASU student profile.
    return null;
  }
}

async function syncStudentIdentity(
  supabaseUrl: string,
  serviceRoleKey: string,
  user: { id: string; email?: string | null },
) {
  const [profile] = await supabaseRest(
    supabaseUrl,
    serviceRoleKey,
    `/profiles?id=eq.${encodeURIComponent(user.id)}&select=id,email,matric,full_name,department,department_id,course_id,avatar_url,institution_id,supervisor_id,role`,
  );
  if (!profile) return jsonResponse({ error: "Student profile was not found" }, 404);
  if (profile.role !== "student") return jsonResponse({ error: "Identity sync is only available for student accounts" }, 403);
  if (!profile.matric || !profile.institution_id) {
    return jsonResponse({ synced: false, source: "none", profile });
  }

  const registry = await lookupRegistry(
    supabaseUrl,
    serviceRoleKey,
    profile.institution_id,
    String(profile.matric).toUpperCase(),
  );
  const sisRecord = await lookupSis(String(profile.matric).toUpperCase(), String(user.email || profile.email || "").toLowerCase());
  const record = sisRecord || registry;
  if (!record) return jsonResponse({ synced: false, source: "none", profile });

  const fullName = firstString(record.full_name, record.name, profile.full_name);
  const department = firstString(record.department, record.department_name, profile.department);
  const departmentId = firstString(record.department_id, profile.department_id);
  const courseId = firstString(record.course_id, profile.course_id);
  const avatarUrl = firstString(record.avatar_url, record.profile_image, record.profile_picture, profile.avatar_url);
  const supervisorEmail = firstString(record.supervisor_email, record.supervisor?.email);
  let supervisorId = profile.supervisor_id || null;

  if (supervisorEmail) {
    const supervisors = await supabaseRest(
      supabaseUrl,
      serviceRoleKey,
      `/profiles?email=eq.${encodeURIComponent(supervisorEmail.toLowerCase())}&role=eq.teacher&institution_id=eq.${encodeURIComponent(profile.institution_id)}&select=id&limit=1`,
    );
    supervisorId = supervisors[0]?.id || supervisorId;
  }

  const [updated] = await supabaseRest(
    supabaseUrl,
    serviceRoleKey,
    `/profiles?id=eq.${encodeURIComponent(user.id)}&select=*`,
    {
      method: "PATCH",
      body: {
        full_name: fullName,
        matric: firstString(record.matric, profile.matric),
        department,
        department_id: departmentId || null,
        course_id: courseId || null,
        avatar_url: avatarUrl || null,
        supervisor_id: supervisorId,
        updated_at: new Date().toISOString(),
      },
    },
  );

  return jsonResponse({
    synced: true,
    source: sisRecord ? "sis" : "registry",
    profile: updated || profile,
    supervisor_id: supervisorId,
  });
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

async function supabaseRest(
  supabaseUrl: string,
  serviceRoleKey: string,
  path: string,
  options: { method?: string; body?: Record<string, unknown> } = {},
) {
  const response = await fetch(`${supabaseUrl}/rest/v1${path}`, {
    method: options.method || "GET",
    headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` },
    ...(options.body ? { body: JSON.stringify(options.body), headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}`, "Content-Type": "application/json", Prefer: "return=representation" } } : {}),
  });
  if (!response.ok) throw new Error(`Identity lookup database request failed (${response.status})`);
  return await response.json();
}

function normalizeString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function firstString(...values: unknown[]) {
  return values.map(normalizeString).find(Boolean) || "";
}

async function getAuthenticatedUser(supabaseUrl: string, supabaseAnonKey: string, authHeader: string) {
  const response = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { apikey: supabaseAnonKey, Authorization: authHeader },
  });
  if (!response.ok) return null;
  return await response.json();
}

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
