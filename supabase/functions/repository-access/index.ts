const DEFAULT_DOWNLOAD_FEE_KOBO = 50_000;
const SIGNED_URL_TTL_SECONDS = 300;

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
    if (!user) return jsonResponse({ error: "Unauthorized" }, 401);

    const [profile] = await supabaseRest(
      supabaseUrl,
      supabaseServiceKey,
      `/profiles?id=eq.${encodeURIComponent(user.id)}&select=id,email,matric,full_name`,
    );
    if (!profile) return jsonResponse({ error: "Profile not found" }, 404);

    const body = await req.json();
    const action = body.action;

    if (action === "get_download_url") {
      return await getDownloadUrl(supabaseUrl, supabaseServiceKey, profile, body);
    }

    if (action === "verify_download") {
      return await verifyDownloadPayment(
        supabaseUrl,
        supabaseServiceKey,
        paystackSecret,
        user,
        profile,
        body,
      );
    }

    return jsonResponse({ error: "Unknown repository access action" }, 400);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unexpected error";
    return jsonResponse({ error: message }, 500);
  }
});

async function getDownloadUrl(
  supabaseUrl: string,
  serviceRoleKey: string,
  profile: Profile,
  body: Record<string, unknown>,
) {
  const projectId = requireString(body.project_id, "project_id");
  const [project] = await getPublishedProject(supabaseUrl, serviceRoleKey, projectId);
  if (!project) return jsonResponse({ error: "Published project not found" }, 404);

  const unlock = await getUnlock(supabaseUrl, serviceRoleKey, profile.id, project.id);
  const config = await getDownloadConfig(supabaseUrl, serviceRoleKey, project.institution_id);

  if (!unlock) {
    return jsonResponse({
      requires_payment: true,
      amount: config.download_fee_kobo,
      currency: config.currency,
      project: publicProject(project),
    });
  }

  const signedUrl = await createSignedUrl(supabaseUrl, serviceRoleKey, project.file_path);
  await writeAudit(supabaseUrl, serviceRoleKey, profile.id, "repository_download_url_issued", project.id, {
    unlock_id: unlock.id,
  });

  return jsonResponse({
    success: true,
    signed_url: signedUrl,
    expires_in: SIGNED_URL_TTL_SECONDS,
    watermark_identity: unlock.watermark_identity,
    project: publicProject(project),
  });
}

async function verifyDownloadPayment(
  supabaseUrl: string,
  serviceRoleKey: string,
  paystackSecret: string,
  user: User,
  profile: Profile,
  body: Record<string, unknown>,
) {
  const projectId = requireString(body.project_id, "project_id");
  const reference = requireString(body.reference, "reference");

  const [project] = await getPublishedProject(supabaseUrl, serviceRoleKey, projectId);
  if (!project) return jsonResponse({ error: "Published project not found" }, 404);

  const existingUnlock = await getUnlock(supabaseUrl, serviceRoleKey, profile.id, project.id);
  if (existingUnlock) {
    const signedUrl = await createSignedUrl(supabaseUrl, serviceRoleKey, project.file_path);
    return jsonResponse({
      success: true,
      signed_url: signedUrl,
      already_unlocked: true,
      watermark_identity: existingUnlock.watermark_identity,
      project: publicProject(project),
    });
  }

  const existingPayment = await supabaseRest(
    supabaseUrl,
    serviceRoleKey,
    `/payments?paystack_reference=eq.${encodeURIComponent(reference)}&select=*`,
  );
  if (existingPayment[0]) {
    return jsonResponse({ error: "Payment reference has already been used" }, 409);
  }

  const config = await getDownloadConfig(supabaseUrl, serviceRoleKey, project.institution_id);
  const paystackRes = await fetch(
    `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
    { headers: { Authorization: `Bearer ${paystackSecret}` } },
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

  if (transaction.amount !== config.download_fee_kobo) {
    return jsonResponse({ error: "Invalid repository download amount" }, 400);
  }

  if (
    transaction.customer?.email &&
    user.email &&
    transaction.customer.email.toLowerCase() !== user.email.toLowerCase()
  ) {
    return jsonResponse({ error: "Payment email does not match logged-in account" }, 403);
  }

  const institutionShare = Math.floor(transaction.amount / 2);
  const providerShare = transaction.amount - institutionShare;

  const [payment] = await supabaseRest(
    supabaseUrl,
    serviceRoleKey,
    "/payments?select=*",
    {
      method: "POST",
      body: {
        student_id: profile.id,
        payer_id: profile.id,
        project_id: project.id,
        amount: transaction.amount,
        currency: transaction.currency || config.currency,
        paystack_reference: reference,
        paystack_transaction_id: String(transaction.id),
        status: "success",
        transaction_type: "repository_download",
        institution_share_kobo: institutionShare,
        provider_share_kobo: providerShare,
        paid_at: transaction.paid_at || new Date().toISOString(),
        metadata: {
          channel: transaction.channel || null,
          customer_email: transaction.customer?.email || null,
        },
      },
    },
  );

  const watermarkIdentity = profile.matric || profile.email || user.email || profile.id;
  const [unlock] = await supabaseRest(
    supabaseUrl,
    serviceRoleKey,
    "/repository_unlocks?select=*",
    {
      method: "POST",
      body: {
        user_id: profile.id,
        project_id: project.id,
        payment_id: payment.id,
        watermark_identity: watermarkIdentity,
      },
    },
  );

  const signedUrl = await createSignedUrl(supabaseUrl, serviceRoleKey, project.file_path);
  await writeAudit(supabaseUrl, serviceRoleKey, profile.id, "repository_download_unlocked", project.id, {
    payment_id: payment.id,
    unlock_id: unlock.id,
    amount: transaction.amount,
  });

  return jsonResponse({
    success: true,
    payment,
    unlock,
    signed_url: signedUrl,
    expires_in: SIGNED_URL_TTL_SECONDS,
    watermark_identity: watermarkIdentity,
    project: publicProject(project),
  });
}

async function getPublishedProject(
  supabaseUrl: string,
  serviceRoleKey: string,
  projectId: string,
) {
  return await supabaseRest(
    supabaseUrl,
    serviceRoleKey,
    `/projects?id=eq.${encodeURIComponent(projectId)}&status=in.(published,cleared)&select=id,institution_id,title,abstract,degree,file_path,status,departments(name)`,
  );
}

async function getUnlock(
  supabaseUrl: string,
  serviceRoleKey: string,
  userId: string,
  projectId: string,
) {
  const unlocks = await supabaseRest(
    supabaseUrl,
    serviceRoleKey,
    `/repository_unlocks?user_id=eq.${encodeURIComponent(userId)}&project_id=eq.${encodeURIComponent(projectId)}&select=*`,
  );
  return unlocks[0] || null;
}

async function getDownloadConfig(
  supabaseUrl: string,
  serviceRoleKey: string,
  institutionId?: string | null,
) {
  if (institutionId) {
    const configs = await supabaseRest(
      supabaseUrl,
      serviceRoleKey,
      `/system_configs?institution_id=eq.${encodeURIComponent(institutionId)}&select=download_fee_kobo,currency`,
    );
    if (configs[0]) return configs[0];
  }

  return { download_fee_kobo: DEFAULT_DOWNLOAD_FEE_KOBO, currency: "NGN" };
}

async function createSignedUrl(
  supabaseUrl: string,
  serviceRoleKey: string,
  filePath: string,
) {
  const res = await fetch(
    `${supabaseUrl}/storage/v1/object/sign/thesis-pdfs/${encodeStoragePath(filePath)}`,
    {
      method: "POST",
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ expiresIn: SIGNED_URL_TTL_SECONDS }),
    },
  );

  if (!res.ok) {
    const message = await getErrorMessage(res);
    throw new Error(message);
  }

  const body = await res.json();
  const signedPath = body.signedURL || body.signedUrl || body.signed_url;
  if (!signedPath) throw new Error("Storage did not return a signed URL");
  return signedPath.startsWith("http") ? signedPath : `${supabaseUrl}${signedPath}`;
}

function publicProject(project: Project) {
  return {
    id: project.id,
    title: project.title,
    abstract: project.abstract,
    degree: project.degree,
    department_name: project.departments?.name || "Department",
  };
}

async function writeAudit(
  supabaseUrl: string,
  serviceRoleKey: string,
  actorId: string,
  action: string,
  projectId: string,
  metadata: Record<string, unknown>,
) {
  await supabaseRest(
    supabaseUrl,
    serviceRoleKey,
    "/audit_logs",
    {
      method: "POST",
      body: {
        actor_id: actorId,
        action,
        entity_type: "project",
        entity_id: projectId,
        metadata,
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
    return body.message || body.error || `Request failed with ${res.status}`;
  } catch (_) {
    return `Request failed with ${res.status}`;
  }
}

function encodeStoragePath(path: string) {
  return path.split("/").map(encodeURIComponent).join("/");
}

function requireString(value: unknown, field: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} is required`);
  }
  return value.trim();
}

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

type User = {
  id: string;
  email?: string;
};

type Profile = {
  id: string;
  email?: string;
  matric?: string;
  full_name?: string;
};

type Project = {
  id: string;
  institution_id?: string | null;
  title: string;
  abstract?: string | null;
  degree?: string | null;
  file_path: string;
  status: string;
  departments?: { name?: string | null } | null;
};
