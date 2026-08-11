import { assertPdfStorageObject } from "../_shared/pdf.ts";

const DEFAULT_CLEARANCE_FEE_KOBO = 200_000;

type SupervisorCandidate = {
  id: string;
  created_at?: string | null;
};

type SupervisorProject = {
  supervisor_id?: string | null;
};

type ProfileRecord = Record<string, unknown>;

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
    if (!authHeader) {
      return jsonResponse({ error: "Missing authorization header" }, 401);
    }

    const paystackSecret = Deno.env.get("PAYSTACK_SECRET_KEY");
    if (!paystackSecret) {
      return jsonResponse({ error: "Paystack secret key is not configured" }, 500);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

    if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceKey) {
      return jsonResponse({ error: "Supabase function environment is not configured" }, 500);
    }

    const user = await getAuthenticatedUser(supabaseUrl, supabaseAnonKey, authHeader);
    if (!user) {
      return jsonResponse({ error: "Unauthorized" }, 401);
    }

    const body = await req.json();
    if (body.action === "initialize_clearance") {
      return await initializeClearancePayment(
        supabaseUrl,
        supabaseServiceKey,
        paystackSecret,
        user,
      );
    }

    const {
      reference,
      file_name,
      file_path,
      title,
      abstract,
      degree,
      file_size_bytes,
      mime_type,
    } = body;
    if (!reference || !file_name || typeof file_path !== "string" || !file_path.trim()) {
      return jsonResponse({ error: "Missing payment reference or file name" }, 400);
    }

    const existingPayments = await supabaseRest(
      supabaseUrl,
      supabaseServiceKey,
      `/payments?paystack_reference=eq.${encodeURIComponent(reference)}&select=*`,
    );
    const existingPayment = existingPayments[0];

    if (existingPayment) {
      if (existingPayment.student_id !== user.id) {
        return jsonResponse({ error: "Payment reference belongs to another user" }, 403);
      }
      return jsonResponse({
        success: true,
        payment: existingPayment,
        already_processed: true,
      });
    }

    const profile = await getStudentProfile(supabaseUrl, supabaseServiceKey, user.id);
    const paymentConfig = await getPaymentConfig(
      supabaseUrl,
      supabaseServiceKey,
      profile?.institution_id,
    );

    const fileSizeBytes = Number(file_size_bytes);
    if (!/\.pdf$/i.test(String(file_name)) || (mime_type && mime_type !== "application/pdf")) {
      return jsonResponse({ error: "Only PDF files are accepted" }, 400);
    }
    if (!Number.isFinite(fileSizeBytes) || fileSizeBytes <= 0 || fileSizeBytes > paymentConfig.max_pdf_size_bytes) {
      return jsonResponse({ error: `The PDF must be between 1 byte and ${Math.round(paymentConfig.max_pdf_size_bytes / (1024 * 1024))} MB` }, 400);
    }
    if (!file_path.startsWith(`${user.id}/`)) {
      return jsonResponse({ error: "Uploaded file must be in the authenticated student's private folder" }, 403);
    }
    try {
      await assertPdfStorageObject(supabaseUrl, supabaseServiceKey, file_path, fileSizeBytes);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Uploaded file could not be validated";
      return jsonResponse({ error: message }, 400);
    }

    const paystackRes = await fetch(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      {
        headers: { Authorization: `Bearer ${paystackSecret}` },
      },
    );
    const paystackData = await paystackRes.json();

    if (!paystackRes.ok || !paystackData.status) {
      return jsonResponse(
        { error: paystackData.message || "Paystack verification failed" },
        400,
      );
    }

    const transaction = paystackData.data;

    if (transaction.status !== "success") {
      return jsonResponse({ error: "Payment was not successful" }, 400);
    }

    if (transaction.amount !== paymentConfig.clearance_fee_kobo) {
      return jsonResponse({ error: "Invalid payment amount" }, 400);
    }

    if (
      transaction.customer?.email &&
      user.email &&
      transaction.customer.email.toLowerCase() !== user.email.toLowerCase()
    ) {
      return jsonResponse(
        { error: "Payment email does not match logged-in account" },
        403,
      );
    }

    const metadata = normalizePaystackMetadata(transaction.metadata);
    if (metadata.payment_type && metadata.payment_type !== "clearance_fee") {
      return jsonResponse({ error: "Payment reference is not for clearance" }, 400);
    }

    const [submission] = await supabaseRest(
      supabaseUrl,
      supabaseServiceKey,
      "/submissions?select=*",
      {
        method: "POST",
        body: {
          student_id: user.id,
          file_name,
          file_path: file_path || null,
          status: "pending",
        },
      },
    );

    const projectTitle =
      typeof title === "string" && title.trim()
        ? title.trim()
        : file_name.replace(/\.pdf$/i, "").replace(/[_-]+/g, " ");

    let createdProjectId: string | null = null;

    try {
      const supervisorId = await resolveSupervisor(
        supabaseUrl,
        supabaseServiceKey,
        user.id,
        profile,
      );
      const workflowStatus = supervisorId ? "supervisor_review" : "submitted";
      const [project] = await supabaseRest(
        supabaseUrl,
        supabaseServiceKey,
        "/projects?select=*",
        {
          method: "POST",
          body: {
            institution_id: profile?.institution_id || null,
            student_id: user.id,
            supervisor_id: supervisorId,
            department_id: profile?.department_id || null,
            submission_id: submission.id,
            title: projectTitle,
            abstract: typeof abstract === "string" && abstract.trim() ? abstract.trim() : null,
            degree: typeof degree === "string" && degree.trim() ? degree.trim() : null,
            file_name,
            file_path,
            file_size_bytes: fileSizeBytes,
            mime_type: "application/pdf",
            status: workflowStatus,
          },
        },
      );
      createdProjectId = project.id;
      const split = calculateSplit(transaction.amount, paymentConfig);

      const [payment] = await supabaseRest(
        supabaseUrl,
        supabaseServiceKey,
        "/payments?select=*",
        {
          method: "POST",
          body: {
            student_id: user.id,
            submission_id: submission.id,
            project_id: project.id,
            payer_id: user.id,
            amount: transaction.amount,
            currency: transaction.currency || paymentConfig.currency,
            paystack_reference: reference,
            paystack_transaction_id: String(transaction.id),
            status: "success",
            transaction_type: "clearance_fee",
            institution_share_kobo: split.institutionShareKobo,
            provider_share_kobo: split.providerShareKobo,
            paid_at: transaction.paid_at || new Date().toISOString(),
            metadata: {
              channel: transaction.channel || null,
              customer_email: transaction.customer?.email || null,
              institution_share_percent: split.institutionSharePercent,
              provider_share_percent: split.providerSharePercent,
              paystack_institution_subaccount: paymentConfig.paystack_institution_subaccount || null,
              paystack_provider_subaccount: paymentConfig.paystack_provider_subaccount || null,
            },
          },
        },
      );

      await supabaseRest(
        supabaseUrl,
        supabaseServiceKey,
        "/project_reviews",
        {
          method: "POST",
          body: {
            project_id: project.id,
            actor_id: user.id,
            action: "submitted",
            comment: "Project submitted after successful clearance fee payment.",
            to_status: workflowStatus,
          },
        },
      );

      await supabaseRest(
        supabaseUrl,
        supabaseServiceKey,
        "/audit_logs",
        {
          method: "POST",
          body: {
            actor_id: user.id,
            action: "clearance_payment_verified",
            entity_type: "project",
            entity_id: project.id,
            metadata: { reference, amount: transaction.amount },
          },
        },
      );

      await notifyUsers(supabaseUrl, supabaseServiceKey, {
        recipientIds: compactIds([user.id, supervisorId]),
        actorId: user.id,
        institutionId: project.institution_id || profile?.institution_id || null,
        projectId: project.id,
        title: "Project submitted",
        message: supervisorId
          ? `"${project.title}" has been submitted for supervisor review.`
          : `"${project.title}" was received and is waiting for a supervisor assignment.`,
        metadata: {
          status: workflowStatus,
          payment_reference: reference,
        },
      });

      if (!supervisorId) {
        await notifyRole(supabaseUrl, supabaseServiceKey, {
          role: "admin",
          institutionId: project.institution_id || profile?.institution_id || null,
          actorId: user.id,
          projectId: project.id,
          title: "Supervisor assignment required",
          message: `"${project.title}" needs a supervisor before review can begin.`,
          metadata: { status: workflowStatus, department_id: profile?.department_id || null },
        });
      }

      return jsonResponse({ success: true, payment, submission, project });
    } catch (err) {
      if (createdProjectId) {
        await supabaseRest(
          supabaseUrl,
          supabaseServiceKey,
          `/projects?id=eq.${encodeURIComponent(createdProjectId)}`,
          { method: "DELETE" },
        );
      }

      if (!createdProjectId && isMissingWorkflowSchema(err)) {
        const [payment] = await insertLegacyPayment(
          supabaseUrl,
          supabaseServiceKey,
          user.id,
          submission.id,
          reference,
          transaction,
        );
        return jsonResponse({
          success: true,
          payment,
          submission,
          legacy_workflow: true,
        });
      }

      await supabaseRest(
        supabaseUrl,
        supabaseServiceKey,
        `/submissions?id=eq.${encodeURIComponent(submission.id)}`,
        { method: "DELETE" },
      );
      throw err;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unexpected error";
    return jsonResponse({ error: message }, 500);
  }
});

async function insertLegacyPayment(
  supabaseUrl: string,
  serviceRoleKey: string,
  studentId: string,
  submissionId: string,
  reference: string,
  transaction: Record<string, unknown>,
) {
  return await supabaseRest(
    supabaseUrl,
    serviceRoleKey,
    "/payments?select=*",
    {
      method: "POST",
      body: {
        student_id: studentId,
        submission_id: submissionId,
        amount: transaction.amount,
        currency: transaction.currency || "NGN",
        paystack_reference: reference,
        paystack_transaction_id: String(transaction.id),
        status: "success",
        paid_at: transaction.paid_at || new Date().toISOString(),
      },
    },
  );
}

async function initializeClearancePayment(
  supabaseUrl: string,
  serviceRoleKey: string,
  paystackSecret: string,
  user: { id: string; email?: string },
) {
  if (!user.email) return jsonResponse({ error: "Authenticated user has no email address" }, 400);

  const profile = await getStudentProfile(supabaseUrl, serviceRoleKey, user.id);
  const paymentConfig = await getPaymentConfig(supabaseUrl, serviceRoleKey, profile?.institution_id);
  const reference = `SPMS-CLR-${Date.now()}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  const split = calculateSplit(paymentConfig.clearance_fee_kobo, paymentConfig);
  const payload = buildPaystackInitializePayload({
    email: user.email,
    amount: paymentConfig.clearance_fee_kobo,
    currency: paymentConfig.currency,
    reference,
    config: paymentConfig,
    metadata: {
      payment_type: "clearance_fee",
      user_id: user.id,
      matric: profile?.matric || null,
      institution_id: profile?.institution_id || null,
      institution_share_kobo: split.institutionShareKobo,
      provider_share_kobo: split.providerShareKobo,
    },
  });

  const paystackData = await initializePaystackTransaction(paystackSecret, payload);
  return jsonResponse({
    success: true,
    reference,
    amount: paymentConfig.clearance_fee_kobo,
    currency: paymentConfig.currency,
    access_code: paystackData.access_code,
    authorization_url: paystackData.authorization_url,
    split_applied: describePaystackSplit(payload),
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

async function getStudentProfile(
  supabaseUrl: string,
  serviceRoleKey: string,
  userId: string,
) {
  try {
    const [profile] = await supabaseRest(
      supabaseUrl,
      serviceRoleKey,
      `/profiles?id=eq.${encodeURIComponent(userId)}&select=id,institution_id,department_id,department,supervisor_id,matric`,
    );
    return profile || null;
  } catch (err) {
    const [profile] = await supabaseRest(
      supabaseUrl,
      serviceRoleKey,
      `/profiles?id=eq.${encodeURIComponent(userId)}&select=id,department,matric`,
    );
    return profile || null;
  }
}

async function resolveSupervisor(
  supabaseUrl: string,
  serviceRoleKey: string,
  studentId: string,
  profile: ProfileRecord | null,
) {
  if (typeof profile?.supervisor_id === "string" && profile.supervisor_id) {
    return profile.supervisor_id;
  }

  // Prefer the supervisor assigned by the SIS/registry. Workload balancing is
  // only a fallback for legacy records that do not carry an official mapping.
  if (typeof profile?.matric === "string" && profile.matric.trim()) {
    try {
      const registry = await supabaseRest(
        supabaseUrl,
        serviceRoleKey,
        `/students_registry?matric=eq.${encodeURIComponent(profile.matric.trim())}&select=supervisor_email`,
      );
      const assignedEmail = String(registry[0]?.supervisor_email || "").trim().toLowerCase();
      if (assignedEmail) {
        const institutionFilter = typeof profile?.institution_id === "string" && profile.institution_id
          ? `&institution_id=eq.${encodeURIComponent(profile.institution_id)}`
          : "";
        const assigned = await supabaseRest(
          supabaseUrl,
          serviceRoleKey,
          `/profiles?role=eq.teacher&email=eq.${encodeURIComponent(assignedEmail)}${institutionFilter}&select=id`,
        );
        if (assigned[0]?.id) return assigned[0].id;
      }
    } catch (err) {
      console.warn(`Official supervisor lookup skipped for ${studentId}:`, err);
    }
  }

  const filters = ["role=eq.teacher"];
  if (typeof profile?.institution_id === "string" && profile.institution_id) {
    filters.push(`institution_id=eq.${encodeURIComponent(profile.institution_id)}`);
  }
  if (typeof profile?.department_id === "string" && profile.department_id) {
    filters.push(`department_id=eq.${encodeURIComponent(profile.department_id)}`);
  } else if (typeof profile?.department === "string" && profile.department.trim()) {
    filters.push(`department=eq.${encodeURIComponent(profile.department.trim())}`);
  }

  try {
    let supervisors: SupervisorCandidate[] = await supabaseRest(
      supabaseUrl,
      serviceRoleKey,
      `/profiles?${filters.join("&")}&select=id,created_at`,
    );

    // A missing department mapping should not strand a paid submission. Fall
    // back to institution-wide staff and let the least-loaded rule decide.
    if (!supervisors.length && filters.length > 1) {
      const institutionFilter = filters.find((filter) => filter.startsWith("institution_id="));
      supervisors = await supabaseRest(
        supabaseUrl,
        serviceRoleKey,
        `/profiles?role=eq.teacher${institutionFilter ? `&${institutionFilter}` : ""}&select=id,created_at`,
      );
    }

    if (!supervisors.length) return null;

    const supervisorIds = supervisors
      .map((supervisor) => supervisor.id)
      .filter((id): id is string => typeof id === "string");
    const activeCounts = new Map<string, number>(supervisorIds.map((id) => [id, 0]));

    try {
      const activeProjects: SupervisorProject[] = await supabaseRest(
        supabaseUrl,
        serviceRoleKey,
        `/projects?supervisor_id=in.(${supervisorIds.join(",")})&status=not.in.(cleared,rejected)&select=supervisor_id`,
      );
      activeProjects.forEach((project) => {
        if (typeof project.supervisor_id === "string" && activeCounts.has(project.supervisor_id)) {
          activeCounts.set(project.supervisor_id, (activeCounts.get(project.supervisor_id) || 0) + 1);
        }
      });
    } catch (err) {
      console.warn("Could not calculate supervisor workload; using creation order:", err);
    }

    supervisors.sort((left, right) => {
      const workloadDifference =
        (activeCounts.get(left.id) || 0) - (activeCounts.get(right.id) || 0);
      if (workloadDifference !== 0) return workloadDifference;
      return String(left.created_at || "").localeCompare(String(right.created_at || ""));
    });

    return supervisors[0]?.id || null;
  } catch (err) {
    console.warn(`Automatic supervisor assignment skipped for ${studentId}:`, err);
    return null;
  }
}

async function notifyRole(
  supabaseUrl: string,
  serviceRoleKey: string,
  notification: {
    role: string;
    institutionId?: string | null;
    actorId?: string | null;
    projectId?: string | null;
    title: string;
    message: string;
    metadata?: Record<string, unknown>;
  },
) {
  try {
    const filters = [`role=eq.${encodeURIComponent(notification.role)}`];
    if (notification.institutionId) {
      filters.push(`institution_id=eq.${encodeURIComponent(notification.institutionId)}`);
    }
    const recipients: Array<{ id?: string | null }> = await supabaseRest(
      supabaseUrl,
      serviceRoleKey,
      `/profiles?${filters.join("&")}&select=id`,
    );
    await notifyUsers(supabaseUrl, serviceRoleKey, {
      recipientIds: recipients
        .map((recipient) => recipient.id)
        .filter((id): id is string => typeof id === "string"),
      actorId: notification.actorId,
      institutionId: notification.institutionId,
      projectId: notification.projectId,
      title: notification.title,
      message: notification.message,
      metadata: notification.metadata,
    });
  } catch (err) {
    console.warn(`Could not notify ${notification.role} staff:`, err);
  }
}

async function getPaymentConfig(
  supabaseUrl: string,
  serviceRoleKey: string,
  institutionId?: string | null,
) {
  if (institutionId) {
    try {
      const configs = await supabaseRest(
        supabaseUrl,
        serviceRoleKey,
        `/system_configs?institution_id=eq.${encodeURIComponent(institutionId)}&select=clearance_fee_kobo,max_pdf_size_bytes,allowed_mime_types,currency,institution_share_percent,provider_share_percent,paystack_split_code,paystack_institution_subaccount,paystack_provider_subaccount`,
      );
      if (configs[0]) return normalizePaymentConfig(configs[0]);
    } catch (err) {
      console.warn("System payment config unavailable:", err);
    }
  }

  return normalizePaymentConfig({});
}

function normalizePaymentConfig(config: Record<string, unknown>) {
  const institutionSharePercent = Number(config.institution_share_percent ?? 50);
  const providerSharePercent = Number(config.provider_share_percent ?? (100 - institutionSharePercent));

  return {
    clearance_fee_kobo: Number(config.clearance_fee_kobo ?? DEFAULT_CLEARANCE_FEE_KOBO),
    max_pdf_size_bytes: Number(config.max_pdf_size_bytes ?? 104857600),
    allowed_mime_types: Array.isArray(config.allowed_mime_types) && config.allowed_mime_types.length ? config.allowed_mime_types : ["application/pdf"],
    currency: String(config.currency || "NGN"),
    institution_share_percent: Number.isFinite(institutionSharePercent) ? institutionSharePercent : 50,
    provider_share_percent: Number.isFinite(providerSharePercent) ? providerSharePercent : 50,
    paystack_split_code:
      typeof config.paystack_split_code === "string"
        ? config.paystack_split_code
        : null,
    paystack_institution_subaccount:
      typeof config.paystack_institution_subaccount === "string"
        ? config.paystack_institution_subaccount
        : null,
    paystack_provider_subaccount:
      typeof config.paystack_provider_subaccount === "string"
        ? config.paystack_provider_subaccount
        : null,
  };
}

async function initializePaystackTransaction(
  paystackSecret: string,
  payload: Record<string, unknown>,
) {
  const res = await fetch("https://api.paystack.co/transaction/initialize", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${paystackSecret}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const body = await res.json();

  if (!res.ok || !body.status) {
    throw new Error(body.message || "Paystack transaction initialization failed");
  }

  return body.data || {};
}

function buildPaystackInitializePayload(options: {
  email: string;
  amount: number;
  currency: string;
  reference: string;
  config: ReturnType<typeof normalizePaymentConfig>;
  metadata: Record<string, unknown>;
}) {
  const payload: Record<string, unknown> = {
    email: options.email,
    amount: String(options.amount),
    currency: options.currency,
    reference: options.reference,
    metadata: JSON.stringify(options.metadata),
  };

  Object.assign(payload, paystackSplitPayload(options.amount, options.config));
  return payload;
}

function paystackSplitPayload(amountKobo: number, config: ReturnType<typeof normalizePaymentConfig>) {
  if (config.paystack_split_code) return { split_code: config.paystack_split_code };

  const institutionSubaccount = config.paystack_institution_subaccount;
  const providerSubaccount = config.paystack_provider_subaccount;
  const split = calculateSplit(amountKobo, config);

  if (institutionSubaccount && providerSubaccount) {
    return {
      split: {
        type: "flat",
        bearer_type: "account",
        subaccounts: [
          { subaccount: institutionSubaccount, share: split.institutionShareKobo },
          { subaccount: providerSubaccount, share: split.providerShareKobo },
        ],
      },
    };
  }

  if (institutionSubaccount) {
    return {
      subaccount: institutionSubaccount,
      transaction_charge: split.providerShareKobo,
      bearer: "account",
    };
  }

  return {};
}

function describePaystackSplit(payload: Record<string, unknown>) {
  if (payload.split_code) return "split_code";
  if (payload.split) return "dynamic_split";
  if (payload.subaccount) return "subaccount";
  return "none";
}

function normalizePaystackMetadata(metadata: unknown) {
  if (!metadata) return {};
  if (typeof metadata === "string") {
    try {
      return JSON.parse(metadata) as Record<string, unknown>;
    } catch (_) {
      return {};
    }
  }
  if (typeof metadata === "object") return metadata as Record<string, unknown>;
  return {};
}

function calculateSplit(amountKobo: number, config: ReturnType<typeof normalizePaymentConfig>) {
  const institutionSharePercent = clampPercent(config.institution_share_percent);
  const providerSharePercent = clampPercent(config.provider_share_percent);
  const totalPercent = institutionSharePercent + providerSharePercent;
  const effectiveInstitutionPercent =
    totalPercent > 0 ? (institutionSharePercent / totalPercent) * 100 : 50;
  const institutionShareKobo = Math.round(amountKobo * (effectiveInstitutionPercent / 100));

  return {
    institutionShareKobo,
    providerShareKobo: amountKobo - institutionShareKobo,
    institutionSharePercent: effectiveInstitutionPercent,
    providerSharePercent: 100 - effectiveInstitutionPercent,
  };
}

function clampPercent(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

function isMissingWorkflowSchema(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes("projects") ||
    message.includes("project_id") ||
    message.includes("transaction_type") ||
    message.includes("Could not find")
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

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
