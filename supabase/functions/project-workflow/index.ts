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
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return jsonResponse({ error: "Missing authorization header" }, 401);

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

    if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceKey) {
      return jsonResponse({ error: "Supabase function environment is not configured" }, 500);
    }

    const user = await getAuthenticatedUser(supabaseUrl, supabaseAnonKey, authHeader);
    if (!user) return jsonResponse({ error: "Unauthorized" }, 401);

    const [actor] = await supabaseRest(
      supabaseUrl,
      supabaseServiceKey,
      `/profiles?id=eq.${encodeURIComponent(user.id)}&select=id,role,full_name,matric`,
    );
    if (!actor) return jsonResponse({ error: "Profile not found" }, 404);

    const body = await req.json();
    const action = body.action;

    if (action === "supervisor_decision") {
      return await handleSupervisorDecision(supabaseUrl, supabaseServiceKey, actor, body);
    }

    if (action === "library_publish") {
      return await handleLibraryPublish(supabaseUrl, supabaseServiceKey, actor, body);
    }

    if (action === "issue_receipt") {
      return await handleIssueReceipt(supabaseUrl, supabaseServiceKey, actor, body);
    }

    return jsonResponse({ error: "Unknown workflow action" }, 400);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unexpected error";
    return jsonResponse({ error: message }, 500);
  }
});

async function handleSupervisorDecision(
  supabaseUrl: string,
  serviceRoleKey: string,
  actor: Profile,
  body: Record<string, unknown>,
) {
  const projectId = requireString(body.project_id, "project_id");
  const decision = requireString(body.decision, "decision");
  const comment = optionalString(body.comment);

  const [project] = await getProject(supabaseUrl, serviceRoleKey, projectId);
  if (!project) return jsonResponse({ error: "Project not found" }, 404);

  if (actor.role !== "admin" && project.supervisor_id !== actor.id) {
    return jsonResponse({ error: "Only the assigned supervisor can review this project" }, 403);
  }

  if (!["submitted", "supervisor_review", "revision_requested"].includes(project.status)) {
    return jsonResponse({ error: `Project is not in supervisor review. Current status: ${project.status}` }, 409);
  }

  let toStatus = "supervisor_approved";
  let reviewAction = "approved";
  let revisionNote = null;

  if (decision === "request_revision") {
    if (!comment) return jsonResponse({ error: "Revision requests require a comment" }, 400);
    toStatus = "revision_requested";
    reviewAction = "revision_requested";
    revisionNote = comment;
  } else if (decision !== "approve") {
    return jsonResponse({ error: "decision must be approve or request_revision" }, 400);
  }

  const [updated] = await supabaseRest(
    supabaseUrl,
    serviceRoleKey,
    `/projects?id=eq.${encodeURIComponent(projectId)}&select=*`,
    {
      method: "PATCH",
      body: {
        status: toStatus,
        revision_note: revisionNote,
        updated_at: new Date().toISOString(),
      },
    },
  );

  await writeReviewAndAudit(supabaseUrl, serviceRoleKey, {
    actorId: actor.id,
    projectId,
    action: reviewAction,
    comment,
    fromStatus: project.status,
    toStatus,
    auditAction: `project_${reviewAction}`,
  });

  return jsonResponse({ success: true, project: updated });
}

async function handleLibraryPublish(
  supabaseUrl: string,
  serviceRoleKey: string,
  actor: Profile,
  body: Record<string, unknown>,
) {
  if (actor.role !== "library" && actor.role !== "admin") {
    return jsonResponse({ error: "Only library staff or admins can publish projects" }, 403);
  }

  const projectId = requireString(body.project_id, "project_id");
  const shelfNumber = requireString(body.shelf_number, "shelf_number");
  const doi = optionalString(body.doi);
  const comment = optionalString(body.comment);

  const [project] = await getProject(supabaseUrl, serviceRoleKey, projectId);
  if (!project) return jsonResponse({ error: "Project not found" }, 404);

  if (!["supervisor_approved", "library_review", "published"].includes(project.status)) {
    return jsonResponse({ error: `Project is not ready for library publishing. Current status: ${project.status}` }, 409);
  }

  const qrPayload = JSON.stringify({
    type: "spms-project",
    endpoint: `${supabaseUrl}/functions/v1/verification-lookup`,
    project_id: project.id,
    shelf_number: shelfNumber,
    issued_at: new Date().toISOString(),
  });

  const [updated] = await supabaseRest(
    supabaseUrl,
    serviceRoleKey,
    `/projects?id=eq.${encodeURIComponent(projectId)}&select=*,departments(name)`,
    {
      method: "PATCH",
      body: {
        status: "published",
        shelf_number: shelfNumber,
        qr_payload: qrPayload,
        doi: doi || project.doi || null,
        metadata_verified_at: project.metadata_verified_at || new Date().toISOString(),
        published_at: project.published_at || new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    },
  );

  await upsertPublicCatalog(supabaseUrl, serviceRoleKey, updated);

  await writeReviewAndAudit(supabaseUrl, serviceRoleKey, {
    actorId: actor.id,
    projectId,
    action: "published",
    comment,
    fromStatus: project.status,
    toStatus: "published",
    auditAction: "project_published_to_catalog",
  });

  return jsonResponse({ success: true, project: updated });
}

async function handleIssueReceipt(
  supabaseUrl: string,
  serviceRoleKey: string,
  actor: Profile,
  body: Record<string, unknown>,
) {
  const projectId = requireString(body.project_id, "project_id");
  const [project] = await getProject(supabaseUrl, serviceRoleKey, projectId);
  if (!project) return jsonResponse({ error: "Project not found" }, 404);

  const isOwner = project.student_id === actor.id;
  const isStaff = ["library", "admin"].includes(actor.role);
  if (!isOwner && !isStaff) {
    return jsonResponse({ error: "You cannot issue a receipt for this project" }, 403);
  }

  if (!["published", "cleared"].includes(project.status)) {
    return jsonResponse({ error: "Receipt is only available after library publishing" }, 409);
  }

  const existing = await supabaseRest(
    supabaseUrl,
    serviceRoleKey,
    `/clearance_receipts?project_id=eq.${encodeURIComponent(projectId)}&select=*`,
  );
  if (existing[0]) {
    return jsonResponse({ success: true, receipt: existing[0], already_issued: true });
  }

  const verificationCode = `SPMS-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  const qrPayload = JSON.stringify({
    type: "spms-clearance-receipt",
    endpoint: `${supabaseUrl}/functions/v1/verification-lookup`,
    project_id: project.id,
    student_id: project.student_id,
    verification_code: verificationCode,
  });

  const [receipt] = await supabaseRest(
    supabaseUrl,
    serviceRoleKey,
    "/clearance_receipts?select=*",
    {
      method: "POST",
      body: {
        project_id: project.id,
        student_id: project.student_id,
        verification_code: verificationCode,
        qr_payload: qrPayload,
      },
    },
  );

  const [updated] = await supabaseRest(
    supabaseUrl,
    serviceRoleKey,
    `/projects?id=eq.${encodeURIComponent(projectId)}&select=*`,
    {
      method: "PATCH",
      body: {
        status: "cleared",
        cleared_at: project.cleared_at || new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    },
  );

  await writeReviewAndAudit(supabaseUrl, serviceRoleKey, {
    actorId: actor.id,
    projectId,
    action: "cleared",
    comment: "Clearance receipt issued.",
    fromStatus: project.status,
    toStatus: "cleared",
    auditAction: "clearance_receipt_issued",
  });

  return jsonResponse({ success: true, receipt, project: updated });
}

async function getProject(supabaseUrl: string, serviceRoleKey: string, projectId: string) {
  return await supabaseRest(
    supabaseUrl,
    serviceRoleKey,
    `/projects?id=eq.${encodeURIComponent(projectId)}&select=*,departments(name)`,
  );
}

async function upsertPublicCatalog(
  supabaseUrl: string,
  serviceRoleKey: string,
  project: Project,
) {
  const departmentName =
    project.departments?.name ||
    project.department_name ||
    "Unassigned Department";

  const existing = await supabaseRest(
    supabaseUrl,
    serviceRoleKey,
    `/public_catalog?project_id=eq.${encodeURIComponent(project.id)}&select=id`,
  );

  const body = {
    project_id: project.id,
    institution_id: project.institution_id || null,
    department_id: project.department_id || null,
    department_name: departmentName,
    title: project.title,
    abstract: project.abstract || null,
    degree: project.degree || null,
    keywords: project.keywords || [],
    shelf_number: project.shelf_number || null,
    doi: project.doi || null,
    published_at: project.published_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  if (existing[0]) {
    return await supabaseRest(
      supabaseUrl,
      serviceRoleKey,
      `/public_catalog?id=eq.${encodeURIComponent(existing[0].id)}&select=*`,
      { method: "PATCH", body },
    );
  }

  return await supabaseRest(
    supabaseUrl,
    serviceRoleKey,
    "/public_catalog?select=*",
    { method: "POST", body },
  );
}

async function writeReviewAndAudit(
  supabaseUrl: string,
  serviceRoleKey: string,
  event: {
    actorId: string;
    projectId: string;
    action: string;
    comment?: string | null;
    fromStatus?: string | null;
    toStatus?: string | null;
    auditAction: string;
  },
) {
  await supabaseRest(
    supabaseUrl,
    serviceRoleKey,
    "/project_reviews",
    {
      method: "POST",
      body: {
        project_id: event.projectId,
        actor_id: event.actorId,
        action: event.action,
        comment: event.comment || null,
        from_status: event.fromStatus || null,
        to_status: event.toStatus || null,
      },
    },
  );

  await supabaseRest(
    supabaseUrl,
    serviceRoleKey,
    "/audit_logs",
    {
      method: "POST",
      body: {
        actor_id: event.actorId,
        action: event.auditAction,
        entity_type: "project",
        entity_id: event.projectId,
        metadata: {
          from_status: event.fromStatus || null,
          to_status: event.toStatus || null,
        },
      },
    },
  );
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

async function getErrorMessage(res: Response) {
  try {
    const body = await res.json();
    return body.message || body.error || `Supabase request failed with ${res.status}`;
  } catch (_) {
    return `Supabase request failed with ${res.status}`;
  }
}

function requireString(value: unknown, field: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} is required`);
  }
  return value.trim();
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

type Profile = {
  id: string;
  role: "student" | "teacher" | "library" | "admin";
  full_name?: string;
  matric?: string;
};

type Project = {
  id: string;
  institution_id?: string | null;
  student_id: string;
  supervisor_id?: string | null;
  department_id?: string | null;
  department_name?: string;
  title: string;
  abstract?: string | null;
  degree?: string | null;
  keywords?: string[];
  status: string;
  shelf_number?: string | null;
  doi?: string | null;
  published_at?: string | null;
  cleared_at?: string | null;
  metadata_verified_at?: string | null;
  departments?: { name?: string | null } | null;
};
