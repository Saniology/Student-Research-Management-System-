import qrcode from "https://esm.sh/qrcode-generator@2.0.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-api-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

    if (!supabaseUrl || !supabaseServiceKey) {
      return jsonResponse({ error: "Supabase function environment is not configured" }, 500);
    }

    const body = await req.json();
    const type = typeof body.type === "string" ? body.type : "";

    if (type === "qr_svg") {
      const payload = requireString(body.payload, "payload");
      const size = typeof body.size === "number" ? body.size : 160;
      return svgResponse(renderQrSvg(payload, size));
    }

    if (type === "receipt") {
      const verificationCode = requireString(body.verification_code, "verification_code");
      return await verifyReceipt(supabaseUrl, supabaseServiceKey, verificationCode);
    }

    if (type === "project") {
      const projectId = requireString(body.project_id, "project_id");
      return await verifyProject(supabaseUrl, supabaseServiceKey, projectId);
    }

    return jsonResponse({ error: "Unknown verification type" }, 400);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unexpected error";
    return jsonResponse({ error: message }, 500);
  }
});

async function verifyReceipt(
  supabaseUrl: string,
  serviceRoleKey: string,
  verificationCode: string,
) {
  const receipts = await supabaseRest(
    supabaseUrl,
    serviceRoleKey,
    `/clearance_receipts?verification_code=eq.${encodeURIComponent(verificationCode)}&select=id,verification_code,issued_at,projects(id,title,status,shelf_number,doi,departments(name)),profiles!clearance_receipts_student_id_fkey(full_name,matric,department)`,
  );

  const receipt = receipts[0];
  if (!receipt) {
    return jsonResponse({ valid: false, error: "Receipt verification code was not found" }, 404);
  }

  return jsonResponse({
    valid: true,
    type: "receipt",
    verification_code: receipt.verification_code,
    issued_at: receipt.issued_at,
    student: {
      full_name: receipt.profiles?.full_name || null,
      matric: receipt.profiles?.matric || null,
      department: receipt.profiles?.department || receipt.projects?.departments?.name || null,
    },
    project: {
      id: receipt.projects?.id || null,
      title: receipt.projects?.title || null,
      status: receipt.projects?.status || null,
      shelf_number: receipt.projects?.shelf_number || null,
      doi: receipt.projects?.doi || null,
    },
  });
}

async function verifyProject(
  supabaseUrl: string,
  serviceRoleKey: string,
  projectId: string,
) {
  const catalog = await supabaseRest(
    supabaseUrl,
    serviceRoleKey,
    `/public_catalog?project_id=eq.${encodeURIComponent(projectId)}&select=project_id,title,abstract,degree,department_name,course_name,shelf_number,doi,published_at`,
  );

  const project = catalog[0];
  if (!project) {
    return jsonResponse({ valid: false, error: "Published project was not found" }, 404);
  }

  return jsonResponse({
    valid: true,
    type: "project",
    project: {
      id: project.project_id,
      title: project.title,
      degree: project.degree,
      department_name: project.department_name,
      course_name: project.course_name,
      shelf_number: project.shelf_number,
      doi: project.doi,
      published_at: project.published_at,
    },
  });
}

async function supabaseRest(
  supabaseUrl: string,
  serviceRoleKey: string,
  path: string,
) {
  const res = await fetch(`${supabaseUrl}/rest/v1${path}`, {
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
    },
  });

  if (!res.ok) {
    const message = await getErrorMessage(res);
    throw new Error(message);
  }

  if (res.status === 204) return [];
  return await res.json();
}

async function getErrorMessage(res: Response) {
  try {
    const body = await res.json();
    return body.message || body.error || `Request failed with ${res.status}`;
  } catch (_) {
    return `Request failed with ${res.status}`;
  }
}

function requireString(value: unknown, field: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} is required`);
  }
  return value.trim();
}

function renderQrSvg(payload: string, size: number) {
  const qr = qrcode(0, "M");
  qr.addData(payload);
  qr.make();
  const moduleCount = qr.getModuleCount();
  const margin = 4;
  const cellSize = Math.max(2, Math.floor(size / (moduleCount + margin * 2)));
  const svg = qr.createSvgTag({ cellSize, margin, scalable: true });
  return svg
    .replace("<svg", '<svg role="img" aria-label="SPMS verification QR code"')
    .replace(/<title>.*?<\/title>/, "");
}

function svgResponse(svg: string, status = 200) {
  return new Response(svg, {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
