const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-api-version, x-health-secret",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== "GET" && req.method !== "POST") {
    return jsonResponse({ status: "error", error: "Method not allowed" }, 405);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const healthSecret = Deno.env.get("HEALTH_CHECK_SECRET") ?? "";
  const detailed = !healthSecret || req.headers.get("x-health-secret") === healthSecret;

  const checks: HealthCheck[] = [
    {
      name: "environment",
      ok: Boolean(supabaseUrl && serviceRoleKey),
      message: supabaseUrl && serviceRoleKey
        ? "Supabase environment is configured"
        : "Supabase environment is missing",
    },
  ];

  if (supabaseUrl && serviceRoleKey) {
    checks.push(await checkRest(supabaseUrl, serviceRoleKey));
    for (const bucket of ["thesis-pdfs", "repository-downloads", "reports"]) {
      checks.push(await checkStorageBucket(supabaseUrl, serviceRoleKey, bucket));
    }
  }

  const status = checks.every((check) => check.ok) ? "ok" : "degraded";
  const response: Record<string, unknown> = {
    service: "spms",
    status,
    checked_at: new Date().toISOString(),
  };

  if (detailed) {
    response.checks = checks;
  } else {
    response.detail = "Provide x-health-secret for detailed checks.";
  }

  return jsonResponse(response, status === "ok" ? 200 : 503);
});

async function checkRest(supabaseUrl: string, serviceRoleKey: string): Promise<HealthCheck> {
  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/institutions?select=id&limit=1`, {
      headers: authHeaders(serviceRoleKey),
    });
    return {
      name: "database",
      ok: res.ok,
      message: res.ok ? "REST database API is reachable" : `REST database API returned ${res.status}`,
    };
  } catch (err) {
    return {
      name: "database",
      ok: false,
      message: err instanceof Error ? err.message : "REST database API failed",
    };
  }
}

async function checkStorageBucket(
  supabaseUrl: string,
  serviceRoleKey: string,
  bucket: string,
): Promise<HealthCheck> {
  try {
    const res = await fetch(`${supabaseUrl}/storage/v1/bucket/${bucket}`, {
      headers: authHeaders(serviceRoleKey),
    });
    return {
      name: `storage:${bucket}`,
      ok: res.ok,
      message: res.ok ? "Storage bucket is reachable" : `Storage bucket returned ${res.status}`,
    };
  } catch (err) {
    return {
      name: `storage:${bucket}`,
      ok: false,
      message: err instanceof Error ? err.message : "Storage bucket check failed",
    };
  }
}

function authHeaders(serviceRoleKey: string) {
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
  };
}

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

type HealthCheck = {
  name: string;
  ok: boolean;
  message: string;
};
