const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-api-version, x-cron-secret",
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
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

    if (!supabaseUrl || !supabaseAnonKey || !serviceRoleKey) {
      return jsonResponse({ error: "Supabase function environment is not configured" }, 500);
    }

    const body = await readJsonBody(req);
    const actor = await authorizeRunner(req, supabaseUrl, supabaseAnonKey, serviceRoleKey);
    const action = typeof body.action === "string" ? body.action : "run_due";

    if (action === "run_once") {
      const reportType = requireString(body.report_type, "report_type");
      const institutionId = optionalString(body.institution_id) || actor?.institution_id || null;
      const result = await generateReport(supabaseUrl, serviceRoleKey, {
        id: null,
        report_type: reportType,
        frequency: "monthly",
        institution_id: institutionId,
        created_by: actor?.id || null,
        metadata: {
          email_recipients: body.email_recipients,
        },
      });
      return jsonResponse({ success: true, generated: [result] });
    }

    if (action !== "run_due") {
      return jsonResponse({ error: "Unknown scheduled report action" }, 400);
    }

    const schedules = await getDueSchedules(supabaseUrl, serviceRoleKey);
    const generated = [];
    for (const schedule of schedules) {
      generated.push(await generateReport(supabaseUrl, serviceRoleKey, schedule));
      await markScheduleRun(supabaseUrl, serviceRoleKey, schedule);
    }

    return jsonResponse({ success: true, generated, due_count: schedules.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unexpected error";
    return jsonResponse({ error: message }, 500);
  }
});

async function authorizeRunner(
  req: Request,
  supabaseUrl: string,
  supabaseAnonKey: string,
  serviceRoleKey: string,
) {
  const cronSecret = Deno.env.get("REPORT_CRON_SECRET");
  const providedSecret = req.headers.get("x-cron-secret") || "";
  if (cronSecret && providedSecret === cronSecret) return null;

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) throw new Error("Missing authorization header");

  const user = await getAuthenticatedUser(supabaseUrl, supabaseAnonKey, authHeader);
  if (!user) throw new Error("Unauthorized");

  const [profile] = await supabaseRest(
    supabaseUrl,
    serviceRoleKey,
    `/profiles?id=eq.${encodeURIComponent(user.id)}&select=id,role,institution_id,full_name`,
  );
  if (!profile || profile.role !== "admin") throw new Error("Only admins can run reports");
  return profile as RunnerProfile;
}

async function getDueSchedules(supabaseUrl: string, serviceRoleKey: string) {
  return await supabaseRest(
    supabaseUrl,
    serviceRoleKey,
    `/report_schedules?is_active=eq.true&next_run_at=lte.${encodeURIComponent(new Date().toISOString())}&select=*`,
  ) as ReportSchedule[];
}

async function generateReport(
  supabaseUrl: string,
  serviceRoleKey: string,
  schedule: ReportSchedule,
) {
  const rows = await reportRows(supabaseUrl, serviceRoleKey, schedule);
  const csv = toCsv(rows);
  const now = new Date();
  const institutionSegment = schedule.institution_id || "global";
  const filePath = [
    institutionSegment,
    schedule.report_type,
    `${now.toISOString().replace(/[:.]/g, "-")}.csv`,
  ].join("/");

  await uploadReport(supabaseUrl, serviceRoleKey, filePath, csv);
  const delivery = await deliverReport(supabaseUrl, serviceRoleKey, schedule, filePath, rows.length);
  const [generated] = await supabaseRest(
    supabaseUrl,
    serviceRoleKey,
    "/generated_reports?select=*",
    {
      method: "POST",
      body: {
        schedule_id: schedule.id,
        institution_id: schedule.institution_id,
        report_type: schedule.report_type,
        file_path: filePath,
        row_count: rows.length,
        metadata: { generated_by: "scheduled-reports", delivery },
      },
    },
  );

  if (schedule.created_by) {
    await notifyUser(supabaseUrl, serviceRoleKey, schedule, generated);
  }

  return {
    id: generated.id,
    report_type: generated.report_type,
    file_path: generated.file_path,
    row_count: generated.row_count,
    generated_at: generated.generated_at,
    delivery,
  };
}

async function reportRows(
  supabaseUrl: string,
  serviceRoleKey: string,
  schedule: ReportSchedule,
) {
  if (schedule.report_type === "student_register") {
    const path = withInstitution(
      "/profiles?role=eq.student&select=full_name,matric,email,department,created_at",
      schedule.institution_id,
    );
    return await supabaseRest(supabaseUrl, serviceRoleKey, path);
  }

  if (schedule.report_type === "project_lifecycle") {
    return await supabaseRest(
      supabaseUrl,
      serviceRoleKey,
      withInstitution(
        "/projects?select=title,degree,status,shelf_number,doi,published_at,cleared_at,created_at,profiles!projects_student_id_fkey(full_name,matric),departments(name)",
        schedule.institution_id,
      ),
    );
  }

  if (schedule.report_type === "financial") {
    const profileJoin = schedule.institution_id
      ? "profiles!payments_student_id_fkey!inner(full_name,matric,institution_id)"
      : "profiles!payments_student_id_fkey(full_name,matric,institution_id)";
    const institutionFilter = schedule.institution_id
      ? `&profiles.institution_id=eq.${encodeURIComponent(schedule.institution_id)}`
      : "";
    return await supabaseRest(
      supabaseUrl,
      serviceRoleKey,
      `/payments?status=eq.success${institutionFilter}&select=amount,currency,transaction_type,institution_share_kobo,provider_share_kobo,paystack_reference,status,paid_at,created_at,${profileJoin}`,
    );
  }

  if (schedule.report_type === "archive") {
    const profileJoin = schedule.institution_id
      ? "profiles!audit_logs_actor_id_fkey!inner(full_name,matric,institution_id)"
      : "profiles!audit_logs_actor_id_fkey(full_name,matric,institution_id)";
    const institutionFilter = schedule.institution_id
      ? `&profiles.institution_id=eq.${encodeURIComponent(schedule.institution_id)}`
      : "";
    return await supabaseRest(
      supabaseUrl,
      serviceRoleKey,
      `/audit_logs?select=created_at,action,entity_type,entity_id,metadata,${profileJoin}${institutionFilter}`,
    );
  }

  throw new Error(`Unsupported report type: ${schedule.report_type}`);
}

function withInstitution(path: string, institutionId?: string | null) {
  if (!institutionId) return path;
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}institution_id=eq.${encodeURIComponent(institutionId)}`;
}

async function markScheduleRun(
  supabaseUrl: string,
  serviceRoleKey: string,
  schedule: ReportSchedule,
) {
  const now = new Date();
  await supabaseRest(
    supabaseUrl,
    serviceRoleKey,
    `/report_schedules?id=eq.${encodeURIComponent(schedule.id || "")}`,
    {
      method: "PATCH",
      body: {
        last_run_at: now.toISOString(),
        next_run_at: nextRunAt(now, schedule.frequency).toISOString(),
        updated_at: now.toISOString(),
      },
    },
  );
}

function nextRunAt(from: Date, frequency: string) {
  const next = new Date(from);
  if (frequency === "daily") next.setDate(next.getDate() + 1);
  else if (frequency === "weekly") next.setDate(next.getDate() + 7);
  else next.setMonth(next.getMonth() + 1);
  return next;
}

async function uploadReport(
  supabaseUrl: string,
  serviceRoleKey: string,
  filePath: string,
  csv: string,
) {
  const res = await fetch(
    `${supabaseUrl}/storage/v1/object/reports/${encodeStoragePath(filePath)}`,
    {
      method: "POST",
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "text/csv; charset=utf-8",
        "x-upsert": "true",
      },
      body: csv,
    },
  );

  if (!res.ok) {
    const message = await getErrorMessage(res);
    throw new Error(`Could not upload report: ${message}`);
  }
}

async function deliverReport(
  supabaseUrl: string,
  serviceRoleKey: string,
  schedule: ReportSchedule,
  filePath: string,
  rowCount: number,
) {
  const scheduleRecipients = reportRecipients(schedule.metadata);
  const fallbackRecipients = reportRecipients({
    email_recipients: Deno.env.get("REPORT_DELIVERY_EMAILS") || "",
  });
  const recipients = scheduleRecipients.length ? scheduleRecipients : fallbackRecipients;
  if (!recipients.length) {
    return { status: "skipped", reason: "no_recipients" };
  }

  const resendApiKey = Deno.env.get("RESEND_API_KEY") || "";
  const fromEmail = Deno.env.get("REPORT_FROM_EMAIL") || "";
  if (!resendApiKey || !fromEmail) {
    return {
      status: "skipped",
      reason: "email_provider_not_configured",
      recipients,
    };
  }

  try {
    const expiresIn = reportLinkTtlSeconds();
    const signedUrl = await createSignedReportUrl(supabaseUrl, serviceRoleKey, filePath, expiresIn);
    const label = reportLabel(schedule.report_type);
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: fromEmail,
        to: recipients,
        subject: `SPMS ${label} report is ready`,
        text: [
          `Your SPMS ${label} report has been generated.`,
          `Rows: ${rowCount}`,
          `Download: ${signedUrl}`,
          `This private link expires in ${Math.round(expiresIn / 3600)} hour(s).`,
        ].join("\n"),
        html: [
          `<p>Your SPMS <strong>${htmlEscape(label)}</strong> report has been generated.</p>`,
          `<p>Rows: ${rowCount}</p>`,
          `<p><a href="${htmlEscape(signedUrl)}">Download report CSV</a></p>`,
          `<p>This private link expires in ${Math.round(expiresIn / 3600)} hour(s).</p>`,
        ].join(""),
      }),
    });

    if (!res.ok) {
      return {
        status: "failed",
        reason: await getErrorMessage(res),
        recipients,
      };
    }

    const body = await res.json().catch(() => ({}));
    return {
      status: "sent",
      provider: "resend",
      provider_id: body.id || null,
      recipients,
      link_expires_in_seconds: expiresIn,
    };
  } catch (err) {
    return {
      status: "failed",
      reason: err instanceof Error ? err.message : "Email delivery failed",
      recipients,
    };
  }
}

async function createSignedReportUrl(
  supabaseUrl: string,
  serviceRoleKey: string,
  filePath: string,
  expiresIn: number,
) {
  const res = await fetch(
    `${supabaseUrl}/storage/v1/object/sign/reports/${encodeStoragePath(filePath)}`,
    {
      method: "POST",
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ expiresIn }),
    },
  );

  if (!res.ok) {
    throw new Error(`Could not create report link: ${await getErrorMessage(res)}`);
  }

  const body = await res.json();
  const signedPath = body.signedURL || body.signedUrl || body.signed_url;
  if (!signedPath) throw new Error("Storage did not return a signed report URL");
  if (String(signedPath).startsWith("http")) return String(signedPath);
  return `${supabaseUrl}/storage/v1${String(signedPath).startsWith("/") ? "" : "/"}${signedPath}`;
}

function reportRecipients(metadata?: Record<string, unknown> | null) {
  const raw = metadata?.email_recipients ?? metadata?.recipients;
  const values = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
      ? raw.split(/[\s,;]+/)
      : [];
  const recipients = values
    .map((value) => String(value ?? "").trim().toLowerCase())
    .filter((value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value));
  return [...new Set(recipients)];
}

function reportLinkTtlSeconds() {
  const value = Number(Deno.env.get("REPORT_LINK_TTL_SECONDS") || 604800);
  return Number.isFinite(value) && value >= 300 ? Math.round(value) : 604800;
}

async function notifyUser(
  supabaseUrl: string,
  serviceRoleKey: string,
  schedule: ReportSchedule,
  generated: Record<string, unknown>,
) {
  try {
    await supabaseRest(
      supabaseUrl,
      serviceRoleKey,
      "/notifications",
      {
        method: "POST",
        body: {
          recipient_id: schedule.created_by,
          institution_id: schedule.institution_id,
          category: "report",
          title: "Scheduled report generated",
          message: `${reportLabel(schedule.report_type)} is ready for download.`,
          action_url: `report:${generated.id}`,
          metadata: { report_id: generated.id, report_type: schedule.report_type },
        },
      },
    );
  } catch (err) {
    console.warn("Report notification skipped:", err);
  }
}

async function getAuthenticatedUser(
  supabaseUrl: string,
  supabaseAnonKey: string,
  authHeader: string,
) {
  const res = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: {
      apikey: supabaseAnonKey,
      Authorization: authHeader,
    },
  });

  if (!res.ok) return null;
  return await res.json();
}

async function supabaseRest(
  supabaseUrl: string,
  serviceRoleKey: string,
  path: string,
  options: {
    method?: string;
    body?: Record<string, unknown>;
  } = {},
) {
  const res = await fetch(`${supabaseUrl}/rest/v1${path}`, {
    method: options.method || "GET",
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (!res.ok) {
    const message = await getErrorMessage(res);
    throw new Error(message);
  }

  if (res.status === 204) return [];
  return await res.json();
}

function toCsv(rows: unknown[]) {
  const normalized = rows.map((row) => flattenRow(row));
  const columns = [...new Set(normalized.flatMap((row) => Object.keys(row)))];
  const header = columns.join(",");
  const body = normalized.map((row) => columns.map((column) => csvEscape(row[column])).join(",")).join("\n");
  return `\uFEFF${header}\n${body}`;
}

function flattenRow(row: unknown, prefix = ""): Record<string, unknown> {
  if (!row || typeof row !== "object") return { [prefix || "value"]: row };
  return Object.entries(row as Record<string, unknown>).reduce((acc, [key, value]) => {
    const field = prefix ? `${prefix}_${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      Object.assign(acc, flattenRow(value, field));
    } else {
      acc[field] = Array.isArray(value) ? JSON.stringify(value) : value;
    }
    return acc;
  }, {} as Record<string, unknown>);
}

function csvEscape(value: unknown) {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function reportLabel(reportType: string) {
  return reportType.replace(/_/g, " ");
}

function htmlEscape(value: unknown) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char] || char));
}

function encodeStoragePath(path: string) {
  return path.split("/").map(encodeURIComponent).join("/");
}

async function getErrorMessage(res: Response) {
  try {
    const body = await res.json();
    return body.message || body.error || `Request failed with ${res.status}`;
  } catch (_) {
    return `Request failed with ${res.status}`;
  }
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function requireString(value: unknown, field: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} is required`);
  }
  return value.trim();
}

async function readJsonBody(req: Request) {
  try {
    return await req.json();
  } catch (_) {
    return {} as Record<string, unknown>;
  }
}

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

type RunnerProfile = {
  id: string;
  role: "admin";
  institution_id?: string | null;
  full_name?: string | null;
};

type ReportSchedule = {
  id: string | null;
  institution_id?: string | null;
  created_by?: string | null;
  report_type: string;
  frequency: string;
  metadata?: Record<string, unknown> | null;
};
