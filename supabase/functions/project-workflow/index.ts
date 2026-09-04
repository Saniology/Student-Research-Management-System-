import { assertPdfStorageObject } from "../_shared/pdf.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-api-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};
const DEFAULT_MAX_PDF_SIZE_BYTES = 104857600;

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
      `/profiles?id=eq.${encodeURIComponent(user.id)}&select=id,role,full_name,matric,institution_id`,
    );
    if (!actor) return jsonResponse({ error: "Profile not found" }, 404);

    const body = await req.json();
    const action = body.action;

    if (action === "supervisor_decision") {
      return await handleSupervisorDecision(supabaseUrl, supabaseServiceKey, actor, body);
    }

    if (action === "student_resubmit") {
      return await handleStudentResubmission(supabaseUrl, supabaseServiceKey, actor, body);
    }

    if (action === "assign_supervisor") {
      return await handleAssignSupervisor(supabaseUrl, supabaseServiceKey, actor, body);
    }

    if (action === "create_supervisor") {
      return await handleCreateSupervisor(supabaseUrl, supabaseServiceKey, actor, body);
    }

    if (action === "assign_student_supervisor") {
      return await handleAssignStudentSupervisor(supabaseUrl, supabaseServiceKey, actor, body);
    }

    if (action === "library_verify") {
      return await handleLibraryVerify(supabaseUrl, supabaseServiceKey, actor, body);
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

async function handleAssignSupervisor(
  supabaseUrl: string,
  serviceRoleKey: string,
  actor: Profile,
  body: Record<string, unknown>,
) {
  if (actor.role !== "admin") {
    return jsonResponse({ error: "Only admins can assign supervisors" }, 403);
  }

  const projectId = requireString(body.project_id, "project_id");
  const supervisorId = requireString(body.supervisor_id, "supervisor_id");
  const [project] = await getProject(supabaseUrl, serviceRoleKey, projectId);
  if (!project) return jsonResponse({ error: "Project not found" }, 404);
  const tenantError = assertProjectTenant(actor, project);
  if (tenantError) return tenantError;

  const supervisors = await supabaseRest(
    supabaseUrl,
    serviceRoleKey,
    `/profiles?id=eq.${encodeURIComponent(supervisorId)}&role=eq.teacher&select=id,full_name,institution_id,department_id`,
  );
  const supervisor = supervisors[0];
  if (!supervisor) return jsonResponse({ error: "Selected supervisor was not found" }, 404);

  if (project.institution_id && supervisor.institution_id !== project.institution_id) {
    return jsonResponse({ error: "Supervisor must belong to the same institution" }, 400);
  }

  if (!await hasPaidClearanceFee(supabaseUrl, serviceRoleKey, project.student_id)) {
    await notifyUsers(supabaseUrl, serviceRoleKey, {
      recipientIds: [supervisor.id],
      actorId: actor.id,
      institutionId: project.institution_id || actor.institution_id || null,
      projectId,
      title: "Assignment blocked: payment pending",
      message: `${project.title} cannot be assigned for review until the student completes the clearance payment.`,
      metadata: { status: "payment_pending", student_id: project.student_id, supervisor_id: supervisor.id },
    });
    return jsonResponse({ error: "This student has not completed the clearance payment. Supervisor assignment is blocked.", code: "PAYMENT_REQUIRED", payment_status: "unpaid" }, 409);
  }

  const nextStatus = project.status === "submitted" ? "supervisor_review" : project.status;
  const [updated] = await supabaseRest(
    supabaseUrl,
    serviceRoleKey,
    `/projects?id=eq.${encodeURIComponent(projectId)}&select=*`,
    {
      method: "PATCH",
      body: {
        supervisor_id: supervisor.id,
        status: nextStatus,
        updated_at: new Date().toISOString(),
      },
    },
  );

  await supabaseRest(supabaseUrl, serviceRoleKey, "/audit_logs", {
    method: "POST",
    body: {
      actor_id: actor.id,
      action: "supervisor_assigned",
      entity_type: "project",
      entity_id: projectId,
      metadata: {
        supervisor_id: supervisor.id,
        from_status: project.status,
        to_status: nextStatus,
      },
    },
  });

  if (project.status === "submitted") {
    await supabaseRest(supabaseUrl, serviceRoleKey, "/project_reviews", {
      method: "POST",
      body: {
        project_id: projectId,
        actor_id: actor.id,
        action: "submitted",
        comment: "Supervisor assigned by an administrator.",
        from_status: "submitted",
        to_status: "supervisor_review",
      },
    });
  }

  await notifyUsers(supabaseUrl, serviceRoleKey, {
    recipientIds: compactIds([project.student_id, supervisor.id]),
    actorId: actor.id,
    institutionId: project.institution_id || actor.institution_id || null,
    projectId,
    title: "Supervisor assigned",
    message: `"${project.title}" is now assigned to ${supervisor.full_name || "a supervisor"} for review.`,
    metadata: { status: nextStatus, supervisor_id: supervisor.id },
  });

  return jsonResponse({ success: true, project: updated, supervisor });
}

async function handleCreateSupervisor(
  supabaseUrl: string,
  serviceRoleKey: string,
  actor: Profile,
  body: Record<string, unknown>,
) {
  if (actor.role !== "admin") return jsonResponse({ error: "Only admins can create supervisors" }, 403);

  const fullName = requireString(body.full_name, "full_name");
  const email = requireString(body.email, "email").toLowerCase();
  const phone = optionalString(body.phone);
  const department = optionalString(body.department);
  const departmentId = optionalString(body.department_id);
  const password = requireString(body.password, "password");
  if (!/^\S+@\S+\.\S+$/.test(email)) return jsonResponse({ error: "Enter a valid supervisor email" }, 400);
  if (password.length < 6) return jsonResponse({ error: "Supervisor password must be at least 6 characters" }, 400);

  const [institution] = await supabaseRest(
    supabaseUrl,
    serviceRoleKey,
    `/institutions?id=eq.${encodeURIComponent(actor.institution_id || "")}&select=id,slug`,
  );
  if (!institution) return jsonResponse({ error: "Admin institution was not found" }, 404);

  const authResponse = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email,
      password,
      email_confirm: true,
      user_metadata: {
        role: "teacher",
        full_name: fullName,
        department,
        department_id: departmentId,
        phone,
        tenant_slug: institution.slug,
      },
    }),
  });
  if (!authResponse.ok) {
    const message = await getErrorMessage(authResponse);
    if (/already|exists|duplicate/i.test(message)) return jsonResponse({ error: "A user with this email already exists" }, 409);
    return jsonResponse({ error: message }, authResponse.status);
  }

  const createdUser = await authResponse.json();
  const [supervisor] = await supabaseRest(
    supabaseUrl,
    serviceRoleKey,
    `/profiles?id=eq.${encodeURIComponent(createdUser.id)}&select=id,full_name,email,phone,department,department_id,institution_id,role`,
    {
      method: "PATCH",
      body: {
        email,
        full_name: fullName,
        phone,
        department,
        department_id: departmentId,
        institution_id: actor.institution_id,
        role: "teacher",
        updated_at: new Date().toISOString(),
      },
    },
  );

  if (!supervisor) return jsonResponse({ error: "Supervisor account was created but its profile could not be prepared" }, 500);
  await supabaseRest(supabaseUrl, serviceRoleKey, "/audit_logs", {
    method: "POST",
    body: {
      actor_id: actor.id,
      action: "supervisor_created",
      entity_type: "profile",
      entity_id: supervisor.id,
      metadata: { email, department, department_id: departmentId },
    },
  });

  return jsonResponse({ success: true, supervisor });
}

async function handleAssignStudentSupervisor(
  supabaseUrl: string,
  serviceRoleKey: string,
  actor: Profile,
  body: Record<string, unknown>,
) {
  if (actor.role !== "admin") return jsonResponse({ error: "Only admins can assign students" }, 403);
  const studentId = requireString(body.student_id, "student_id");
  const supervisorId = requireString(body.supervisor_id, "supervisor_id");

  const [student] = await supabaseRest(
    supabaseUrl,
    serviceRoleKey,
    `/profiles?id=eq.${encodeURIComponent(studentId)}&role=eq.student&select=id,full_name,email,matric,department,institution_id,supervisor_id`,
  );
  const [supervisor] = await supabaseRest(
    supabaseUrl,
    serviceRoleKey,
    `/profiles?id=eq.${encodeURIComponent(supervisorId)}&role=eq.teacher&select=id,full_name,email,phone,department,institution_id`,
  );
  if (!student) return jsonResponse({ error: "Student was not found" }, 404);
  if (!supervisor) return jsonResponse({ error: "Supervisor was not found" }, 404);
  if (student.institution_id !== actor.institution_id || supervisor.institution_id !== actor.institution_id) {
    return jsonResponse({ error: "Student and supervisor must belong to the same institution" }, 400);
  }

  if (!await hasPaidClearanceFee(supabaseUrl, serviceRoleKey, student.id)) {
    await notifyUsers(supabaseUrl, serviceRoleKey, {
      recipientIds: [supervisor.id],
      actorId: actor.id,
      institutionId: actor.institution_id || null,
      title: "Assignment blocked: payment pending",
      message: `${student.full_name || "This student"} cannot be assigned to you until the clearance payment is completed.`,
      metadata: { status: "payment_pending", student_id: student.id, supervisor_id: supervisor.id },
    });
    return jsonResponse({ error: "This student has not completed the clearance payment. Supervisor assignment is blocked.", code: "PAYMENT_REQUIRED", payment_status: "unpaid" }, 409);
  }

  const [updatedStudent] = await supabaseRest(
    supabaseUrl,
    serviceRoleKey,
    `/profiles?id=eq.${encodeURIComponent(studentId)}&select=id,full_name,email,matric,department,institution_id,supervisor_id`,
    { method: "PATCH", body: { supervisor_id: supervisor.id, updated_at: new Date().toISOString() } },
  );
  const activeProjects = await supabaseRest(
    supabaseUrl,
    serviceRoleKey,
    `/projects?student_id=eq.${encodeURIComponent(studentId)}&status=not.in.(cleared,rejected)&select=id,status`,
  );
  const updatedProjects = await Promise.all(activeProjects.map((project: { id: string; status: string }) =>
    supabaseRest(supabaseUrl, serviceRoleKey, `/projects?id=eq.${encodeURIComponent(project.id)}&select=id,supervisor_id,status`, {
      method: "PATCH",
      body: {
        supervisor_id: supervisor.id,
        status: project.status === "submitted" ? "supervisor_review" : project.status,
        updated_at: new Date().toISOString(),
      },
    }).then((rows) => rows[0]),
  ));

  await supabaseRest(supabaseUrl, serviceRoleKey, "/audit_logs", {
    method: "POST",
    body: {
      actor_id: actor.id,
      action: "student_supervisor_assigned",
      entity_type: "profile",
      entity_id: student.id,
      metadata: { student_id: student.id, supervisor_id: supervisor.id, previous_supervisor_id: student.supervisor_id || null },
    },
  });
  await notifyUsers(supabaseUrl, serviceRoleKey, {
    recipientIds: compactIds([student.id, supervisor.id]),
    actorId: actor.id,
    institutionId: actor.institution_id || null,
    title: "Supervisor assignment updated",
    message: `${student.full_name || "Student"} is now assigned to ${supervisor.full_name || "a supervisor"}.`,
    metadata: { student_id: student.id, supervisor_id: supervisor.id },
  });

  return jsonResponse({ success: true, student: updatedStudent, supervisor, projects: updatedProjects });
}

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
  const tenantError = assertProjectTenant(actor, project);
  if (tenantError) return tenantError;

  if (actor.role !== "admin" && project.supervisor_id !== actor.id) {
    return jsonResponse({ error: "Only the assigned supervisor can review this project" }, 403);
  }

  if (!await hasPaidClearanceFee(supabaseUrl, serviceRoleKey, project.student_id)) {
    return jsonResponse({ error: "This student has not completed the clearance payment. Supervisor review is blocked.", code: "PAYMENT_REQUIRED", payment_status: "unpaid" }, 409);
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

  if (toStatus === "revision_requested") {
    await notifyUsers(supabaseUrl, serviceRoleKey, {
      recipientIds: [project.student_id],
      actorId: actor.id,
      institutionId: project.institution_id || null,
      projectId,
      title: "Revision requested",
      message: `${actor.full_name || "Your supervisor"} requested revisions for "${project.title}".`,
      metadata: { status: toStatus, comment },
    });
  } else {
    await notifyUsers(supabaseUrl, serviceRoleKey, {
      recipientIds: [project.student_id],
      actorId: actor.id,
      institutionId: project.institution_id || null,
      projectId,
      title: "Supervisor approval complete",
      message: `"${project.title}" has been approved and routed to library verification.`,
      metadata: { status: toStatus },
    });
    await notifyRole(supabaseUrl, serviceRoleKey, {
      role: "library",
      actorId: actor.id,
      institutionId: project.institution_id || null,
      projectId,
      title: "Project ready for library review",
      message: `"${project.title}" is ready for metadata verification and catalog publishing.`,
      metadata: { status: toStatus },
    });
  }

  return jsonResponse({ success: true, project: updated });
}

async function handleStudentResubmission(
  supabaseUrl: string,
  serviceRoleKey: string,
  actor: Profile,
  body: Record<string, unknown>,
) {
  if (actor.role !== "student") {
    return jsonResponse({ error: "Only students can resubmit a revision" }, 403);
  }

  const projectId = requireString(body.project_id, "project_id");
  const filePath = requireString(body.file_path, "file_path");
  const fileName = requireString(body.file_name, "file_name");
  const [project] = await getProject(supabaseUrl, serviceRoleKey, projectId);
  if (!project) return jsonResponse({ error: "Project not found" }, 404);
  const tenantError = assertProjectTenant(actor, project);
  if (tenantError) return tenantError;
  if (project.student_id !== actor.id) {
    return jsonResponse({ error: "You can only resubmit your own project" }, 403);
  }
  if (project.status !== "revision_requested") {
    return jsonResponse({ error: `Project is not waiting for a revision. Current status: ${project.status}` }, 409);
  }
  const mimeType = optionalString(body.mime_type);
  const fileSizeBytes = Number(body.file_size_bytes);
  if (!filePath.startsWith(`${actor.id}/`) || !/\.pdf$/i.test(fileName) || (mimeType && mimeType !== "application/pdf")) {
    return jsonResponse({ error: "Revision files must be PDF files in the student's private folder" }, 400);
  }
  const maxPdfSizeBytes = await getMaxPdfSize(supabaseUrl, serviceRoleKey, actor.institution_id);
  if (!Number.isFinite(fileSizeBytes) || fileSizeBytes <= 0 || fileSizeBytes > maxPdfSizeBytes) {
    return jsonResponse({ error: `The PDF must be between 1 byte and ${Math.round(maxPdfSizeBytes / (1024 * 1024))} MB` }, 400);
  }
  try {
    await assertPdfStorageObject(supabaseUrl, serviceRoleKey, filePath, fileSizeBytes);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Uploaded file could not be validated";
    return jsonResponse({ error: message }, 400);
  }

  const title = optionalString(body.title) || project.title;
  const abstract = optionalString(body.abstract) || project.abstract;
  const degree = optionalString(body.degree) || project.degree;
  const courseId = optionalString(body.course_id) || project.course_id || null;
  if (!abstract || abstract.length < 50) {
    return jsonResponse({ error: "A complete abstract is required before resubmission" }, 400);
  }

  const [updated] = await supabaseRest(
    supabaseUrl,
    serviceRoleKey,
    `/projects?id=eq.${encodeURIComponent(projectId)}&select=*`,
    {
      method: "PATCH",
      body: {
        title,
        abstract,
        degree,
        course_id: courseId,
        file_name: fileName,
        file_path: filePath,
        file_size_bytes: fileSizeBytes,
        mime_type: "application/pdf",
        status: project.supervisor_id ? "supervisor_review" : "submitted",
        revision_note: null,
        updated_at: new Date().toISOString(),
      },
    },
  );

  if (project.submission_id) {
    await supabaseRest(
      supabaseUrl,
      serviceRoleKey,
      `/submissions?id=eq.${encodeURIComponent(project.submission_id)}`,
      {
        method: "PATCH",
        body: { file_name: fileName, file_path: filePath, status: "pending" },
      },
    );
  }

  const nextStatus = project.supervisor_id ? "supervisor_review" : "submitted";
  await writeReviewAndAudit(supabaseUrl, serviceRoleKey, {
    actorId: actor.id,
    projectId,
    action: "submitted",
    comment: "Student resubmitted the revised thesis after supervisor feedback.",
    fromStatus: project.status,
    toStatus: nextStatus,
    auditAction: "project_revision_resubmitted",
  });

  await notifyUsers(supabaseUrl, serviceRoleKey, {
    recipientIds: compactIds([actor.id, project.supervisor_id]),
    actorId: actor.id,
    institutionId: project.institution_id || null,
    projectId,
    title: "Revision resubmitted",
    message: `"${title}" has been resubmitted and is ready for supervisor review.`,
    metadata: { status: nextStatus },
  });

  if (!project.supervisor_id) {
    await notifyRole(supabaseUrl, serviceRoleKey, {
      role: "admin",
      actorId: actor.id,
      institutionId: project.institution_id || null,
      projectId,
      title: "Supervisor assignment required",
      message: `"${title}" was resubmitted but still needs a supervisor assignment.`,
      metadata: { status: nextStatus },
    });
  }

  return jsonResponse({ success: true, project: updated });
}

async function getMaxPdfSize(supabaseUrl: string, serviceRoleKey: string, institutionId?: string | null) {
  if (!institutionId) return DEFAULT_MAX_PDF_SIZE_BYTES;
  const configs = await supabaseRest(
    supabaseUrl,
    serviceRoleKey,
    `/system_configs?institution_id=eq.${encodeURIComponent(institutionId)}&select=max_pdf_size_bytes`,
  );
  const configured = Number(configs[0]?.max_pdf_size_bytes);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MAX_PDF_SIZE_BYTES;
}

async function handleLibraryVerify(
  supabaseUrl: string,
  serviceRoleKey: string,
  actor: Profile,
  body: Record<string, unknown>,
) {
  if (actor.role !== "library" && actor.role !== "admin") {
    return jsonResponse({ error: "Only library staff or admins can verify metadata" }, 403);
  }

  const projectId = requireString(body.project_id, "project_id");
  const comment = optionalString(body.comment);
  const [project] = await getProject(supabaseUrl, serviceRoleKey, projectId);
  if (!project) return jsonResponse({ error: "Project not found" }, 404);
  const tenantError = assertProjectTenant(actor, project);
  if (tenantError) return tenantError;

  if (!["supervisor_approved", "library_review"].includes(project.status)) {
    return jsonResponse({ error: `Project is not ready for metadata verification. Current status: ${project.status}` }, 409);
  }

  if (!project.title?.trim() || !project.abstract?.trim() || !project.degree?.trim()) {
    return jsonResponse({ error: "Title, abstract, and degree metadata are required before verification" }, 400);
  }

  const verifiedAt = project.metadata_verified_at || new Date().toISOString();
  const [updated] = await supabaseRest(
    supabaseUrl,
    serviceRoleKey,
    `/projects?id=eq.${encodeURIComponent(projectId)}&select=*`,
    {
      method: "PATCH",
      body: {
        status: "library_review",
        metadata_verified_at: verifiedAt,
        updated_at: new Date().toISOString(),
      },
    },
  );

  await writeReviewAndAudit(supabaseUrl, serviceRoleKey, {
    actorId: actor.id,
    projectId,
    action: "metadata_verified",
    comment,
    fromStatus: project.status,
    toStatus: "library_review",
    auditAction: "project_metadata_verified",
  });

  await notifyUsers(supabaseUrl, serviceRoleKey, {
    recipientIds: compactIds([project.student_id, project.supervisor_id]),
    actorId: actor.id,
    institutionId: project.institution_id || actor.institution_id || null,
    projectId,
    title: "Metadata verified",
    message: `"${project.title}" metadata has been verified by the library.`,
    metadata: { status: "library_review", metadata_verified_at: verifiedAt },
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
  const tenantError = assertProjectTenant(actor, project);
  if (tenantError) return tenantError;

  if (!["supervisor_approved", "library_review", "published"].includes(project.status)) {
    return jsonResponse({ error: `Project is not ready for library publishing. Current status: ${project.status}` }, 409);
  }

  if (project.status === "supervisor_approved" && !project.metadata_verified_at) {
    return jsonResponse({ error: "Verify project metadata before publishing" }, 409);
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
    `/projects?id=eq.${encodeURIComponent(projectId)}&select=*,departments(name),courses(name)`,
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

  await notifyUsers(supabaseUrl, serviceRoleKey, {
    recipientIds: compactIds([project.student_id, project.supervisor_id]),
    actorId: actor.id,
    institutionId: project.institution_id || null,
    projectId,
    title: "Project published",
    message: `"${project.title}" is now published in the institutional repository.`,
    metadata: { status: "published", shelf_number: shelfNumber, doi: doi || project.doi || null },
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
  const tenantError = assertProjectTenant(actor, project);
  if (tenantError) return tenantError;

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

  await notifyUsers(supabaseUrl, serviceRoleKey, {
    recipientIds: [project.student_id],
    actorId: actor.id,
    institutionId: project.institution_id || null,
    projectId,
    title: "Clearance receipt issued",
    message: `Your clearance receipt for "${project.title}" is ready for verification and download.`,
    metadata: { status: "cleared", verification_code: verificationCode },
  });

  return jsonResponse({ success: true, receipt, project: updated });
}

function assertProjectTenant(actor: Profile, project: Project) {
  if (project.institution_id && actor.institution_id !== project.institution_id) {
    return jsonResponse({ error: "Project belongs to another institution" }, 403);
  }
  return null;
}

async function getProject(supabaseUrl: string, serviceRoleKey: string, projectId: string) {
  return await supabaseRest(
    supabaseUrl,
    serviceRoleKey,
    `/projects?id=eq.${encodeURIComponent(projectId)}&select=*,departments(name),courses(name)`,
  );
}

async function hasPaidClearanceFee(supabaseUrl: string, serviceRoleKey: string, studentId: string) {
  const payments = await supabaseRest(
    supabaseUrl,
    serviceRoleKey,
    `/payments?student_id=eq.${encodeURIComponent(studentId)}&status=eq.success&transaction_type=eq.clearance_fee&select=id&limit=1`,
  );
  return payments.length > 0;
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
    course_id: project.course_id || null,
    course_name: project.courses?.name || null,
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

async function notifyRole(
  supabaseUrl: string,
  serviceRoleKey: string,
  notification: {
    role: Profile["role"];
    actorId: string;
    institutionId?: string | null;
    projectId?: string | null;
    title: string;
    message: string;
    metadata?: Record<string, unknown>;
  },
) {
  let path = `/profiles?role=eq.${encodeURIComponent(notification.role)}&select=id`;
  if (notification.institutionId) {
    path += `&institution_id=eq.${encodeURIComponent(notification.institutionId)}`;
  }

  let recipients: Array<{ id?: string }> = [];
  try {
    recipients = await supabaseRest(supabaseUrl, serviceRoleKey, path);
  } catch (err) {
    console.warn("Role notification recipient lookup skipped:", err);
    return;
  }

  await notifyUsers(supabaseUrl, serviceRoleKey, {
    recipientIds: compactIds(recipients.map((recipient) => recipient.id)),
    actorId: notification.actorId,
    institutionId: notification.institutionId || null,
    projectId: notification.projectId || null,
    title: notification.title,
    message: notification.message,
    metadata: notification.metadata || {},
  });
}

async function notifyUsers(
  supabaseUrl: string,
  serviceRoleKey: string,
  notification: {
    recipientIds: string[];
    actorId?: string | null;
    institutionId?: string | null;
    projectId?: string | null;
    title: string;
    message: string;
    metadata?: Record<string, unknown>;
  },
) {
  const recipientIds = [...new Set(notification.recipientIds)].filter(Boolean);
  if (!recipientIds.length) return;

  try {
    await supabaseRest(
      supabaseUrl,
      serviceRoleKey,
      "/notifications",
      {
        method: "POST",
        body: recipientIds.map((recipientId) => ({
          recipient_id: recipientId,
          actor_id: notification.actorId || null,
          institution_id: notification.institutionId || null,
          project_id: notification.projectId || null,
          category: "workflow",
          title: notification.title,
          message: notification.message,
          action_url: notification.projectId ? `project:${notification.projectId}` : null,
          metadata: notification.metadata || {},
        })),
      },
    );
  } catch (err) {
    console.warn("Notification insert skipped:", err);
  }
}

function compactIds(values: Array<string | null | undefined>) {
  return values.filter((value): value is string => Boolean(value));
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
    body?: Record<string, unknown> | Array<Record<string, unknown>>;
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
  institution_id?: string | null;
};

type Project = {
  id: string;
  institution_id?: string | null;
  student_id: string;
  supervisor_id?: string | null;
  department_id?: string | null;
  course_id?: string | null;
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
  courses?: { name?: string | null } | null;
};
