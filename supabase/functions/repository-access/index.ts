import {
  degrees,
  PDFDocument,
  rgb,
  StandardFonts,
} from "https://esm.sh/pdf-lib@1.17.1";

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
    if (!authHeader) {
      return jsonResponse({ error: "Repository downloads require an authenticated account" }, 401);
    }

    const body = await req.json();
    const action = body.action;

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
      `/profiles?id=eq.${encodeURIComponent(user.id)}&select=id,email,matric,full_name,institution_id`,
    );
    if (!profile) return jsonResponse({ error: "Profile not found" }, 404);

    if (action === "get_download_url") {
      return await getDownloadUrl(supabaseUrl, supabaseServiceKey, profile, body);
    }

    if (action === "initialize_download") {
      return await initializeDownloadPayment(
        supabaseUrl,
        supabaseServiceKey,
        paystackSecret,
        user,
        profile,
        body,
      );
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
  const tenantError = assertProjectTenant(profile, project);
  if (tenantError) return tenantError;

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

  const signedUrl = await createWatermarkedDownloadUrl(
    supabaseUrl,
    serviceRoleKey,
    project,
    unlock.watermark_identity,
  );
  await writeAudit(supabaseUrl, serviceRoleKey, profile.id, "repository_watermarked_download_url_issued", project.id, {
    unlock_id: unlock.id,
    watermark_identity: unlock.watermark_identity,
  });

  return jsonResponse({
    success: true,
    signed_url: signedUrl,
    expires_in: SIGNED_URL_TTL_SECONDS,
    watermark_identity: unlock.watermark_identity,
    watermarked: true,
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
  const tenantError = assertProjectTenant(profile, project);
  if (tenantError) return tenantError;

  const existingUnlock = await getUnlock(supabaseUrl, serviceRoleKey, profile.id, project.id);
  if (existingUnlock) {
    const signedUrl = await createWatermarkedDownloadUrl(
      supabaseUrl,
      serviceRoleKey,
      project,
      existingUnlock.watermark_identity,
    );
    return jsonResponse({
      success: true,
      signed_url: signedUrl,
      already_unlocked: true,
      watermark_identity: existingUnlock.watermark_identity,
      watermarked: true,
      project: publicProject(project),
    });
  }

  const existingPayment = await supabaseRest(
    supabaseUrl,
    serviceRoleKey,
    `/payments?paystack_reference=eq.${encodeURIComponent(reference)}&select=*`,
  );
  if (existingPayment[0]) {
    const payment = existingPayment[0];
    if (
      payment.transaction_type !== "repository_download" ||
      payment.student_id !== profile.id ||
      payment.project_id !== project.id
    ) {
      return jsonResponse({ error: "Payment reference has already been used" }, 409);
    }
    let unlock = await getUnlock(supabaseUrl, serviceRoleKey, profile.id, project.id);
    if (!unlock) {
      const watermarkIdentity = profile.matric || profile.email || user.email || profile.id;
      [unlock] = await supabaseRest(
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
    }
    const watermarkIdentity = unlock.watermark_identity;
    const signedUrl = await createWatermarkedDownloadUrl(
      supabaseUrl,
      serviceRoleKey,
      project,
      watermarkIdentity,
    );
    await writeAudit(supabaseUrl, serviceRoleKey, profile.id, "repository_watermarked_download_url_issued", project.id, {
      unlock_id: unlock.id,
      payment_id: payment.id,
      watermark_identity: watermarkIdentity,
      retry: true,
    });
    return jsonResponse({
      success: true,
      payment,
      unlock,
      already_unlocked: true,
      signed_url: signedUrl,
      expires_in: SIGNED_URL_TTL_SECONDS,
      watermark_identity: watermarkIdentity,
      watermarked: true,
      project: publicProject(project),
    });
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

  const metadata = normalizePaystackMetadata(transaction.metadata);
  if (metadata.payment_type && metadata.payment_type !== "repository_download") {
    return jsonResponse({ error: "Payment reference is not for a repository download" }, 400);
  }
  if (metadata.project_id && metadata.project_id !== project.id) {
    return jsonResponse({ error: "Payment reference belongs to another project" }, 403);
  }

  const split = calculateSplit(transaction.amount, config);

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
        institution_share_kobo: split.institutionShareKobo,
        provider_share_kobo: split.providerShareKobo,
        paid_at: transaction.paid_at || new Date().toISOString(),
        metadata: {
          channel: transaction.channel || null,
          customer_email: transaction.customer?.email || null,
          institution_share_percent: split.institutionSharePercent,
          provider_share_percent: split.providerSharePercent,
          paystack_institution_subaccount: config.paystack_institution_subaccount || null,
          paystack_provider_subaccount: config.paystack_provider_subaccount || null,
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

  const signedUrl = await createWatermarkedDownloadUrl(
    supabaseUrl,
    serviceRoleKey,
    project,
    watermarkIdentity,
  );
  await writeAudit(supabaseUrl, serviceRoleKey, profile.id, "repository_download_unlocked", project.id, {
    payment_id: payment.id,
    unlock_id: unlock.id,
    amount: transaction.amount,
    watermark_identity: watermarkIdentity,
  });

  return jsonResponse({
    success: true,
    payment,
    unlock,
    signed_url: signedUrl,
    expires_in: SIGNED_URL_TTL_SECONDS,
    watermark_identity: watermarkIdentity,
    watermarked: true,
    project: publicProject(project),
  });
}

async function initializeGuestDownloadPayment(
  supabaseUrl: string,
  serviceRoleKey: string,
  paystackSecret: string,
  body: Record<string, unknown>,
) {
  const email = requireEmail(body.email);
  const projectId = requireString(body.project_id, "project_id");
  const [project] = await getPublishedProject(supabaseUrl, serviceRoleKey, projectId);
  if (!project) return jsonResponse({ error: "Published project not found" }, 404);

  const config = await getDownloadConfig(supabaseUrl, serviceRoleKey, project.institution_id);
  const reference = `SPMS-GUEST-DL-${Date.now()}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  const split = calculateSplit(config.download_fee_kobo, config);
  const payload = buildPaystackInitializePayload({
    email,
    amount: config.download_fee_kobo,
    currency: config.currency,
    reference,
    config,
    metadata: {
      payment_type: "repository_guest_download",
      project_id: project.id,
      guest_email: email,
      institution_id: project.institution_id || null,
      institution_share_kobo: split.institutionShareKobo,
      provider_share_kobo: split.providerShareKobo,
    },
  });
  const paystackData = await initializePaystackTransaction(paystackSecret, payload);
  return jsonResponse({
    success: true,
    guest: true,
    reference,
    amount: config.download_fee_kobo,
    currency: config.currency,
    access_code: paystackData.access_code,
    authorization_url: paystackData.authorization_url,
    split_applied: describePaystackSplit(payload),
    project: publicProject(project),
  });
}

async function verifyGuestDownloadPayment(
  supabaseUrl: string,
  serviceRoleKey: string,
  paystackSecret: string,
  body: Record<string, unknown>,
) {
  const email = requireEmail(body.email);
  const projectId = requireString(body.project_id, "project_id");
  const reference = requireString(body.reference, "reference");
  const [project] = await getPublishedProject(supabaseUrl, serviceRoleKey, projectId);
  if (!project) return jsonResponse({ error: "Published project not found" }, 404);

  const existing = await supabaseRest(
    supabaseUrl,
    serviceRoleKey,
    `/guest_download_orders?paystack_reference=eq.${encodeURIComponent(reference)}&select=*`,
  );
  if (existing[0]) {
    const order = existing[0];
    if (order.project_id !== project.id || String(order.email).toLowerCase() !== email) {
      return jsonResponse({ error: "Payment reference has already been used" }, 409);
    }
    const watermarkIdentity = order.watermark_identity || `guest-${email}`;
    const signedUrl = await createWatermarkedDownloadUrl(
      supabaseUrl,
      serviceRoleKey,
      project,
      watermarkIdentity,
    );
    return jsonResponse({
      success: true,
      guest: true,
      order,
      already_unlocked: true,
      signed_url: signedUrl,
      expires_in: SIGNED_URL_TTL_SECONDS,
      watermark_identity: watermarkIdentity,
      watermarked: true,
      project: publicProject(project),
    });
  }

  const config = await getDownloadConfig(supabaseUrl, serviceRoleKey, project.institution_id);
  const paystackRes = await fetch(
    `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
    { headers: { Authorization: `Bearer ${paystackSecret}` } },
  );
  const paystackData = await paystackRes.json();
  if (!paystackRes.ok || !paystackData.status) {
    return jsonResponse({ error: paystackData.message || "Paystack verification failed" }, 400);
  }

  const transaction = paystackData.data;
  if (transaction.status !== "success") return jsonResponse({ error: "Payment was not successful" }, 400);
  if (transaction.amount !== config.download_fee_kobo) return jsonResponse({ error: "Invalid repository download amount" }, 400);
  if (!transaction.customer?.email || transaction.customer.email.toLowerCase() !== email) {
    return jsonResponse({ error: "Payment email does not match the guest email" }, 403);
  }

  const metadata = normalizePaystackMetadata(transaction.metadata);
  if (metadata.payment_type !== "repository_guest_download") {
    return jsonResponse({ error: "Payment reference is not for a guest repository download" }, 400);
  }
  if (metadata.project_id !== project.id) {
    return jsonResponse({ error: "Payment reference belongs to another project" }, 403);
  }
  if (typeof metadata.guest_email !== "string" || metadata.guest_email.toLowerCase() !== email) {
    return jsonResponse({ error: "Payment reference belongs to another guest email" }, 403);
  }

  const watermarkIdentity = `guest-${email}`;
  const signedUrl = await createWatermarkedDownloadUrl(
    supabaseUrl,
    serviceRoleKey,
    project,
    watermarkIdentity,
  );
  const split = calculateSplit(transaction.amount, config);
  const [order] = await supabaseRest(
    supabaseUrl,
    serviceRoleKey,
    "/guest_download_orders?select=*",
    {
      method: "POST",
      body: {
        institution_id: project.institution_id || null,
        project_id: project.id,
        email,
        paystack_reference: reference,
        paystack_transaction_id: String(transaction.id),
        amount: transaction.amount,
        currency: transaction.currency || config.currency,
        status: "success",
        watermark_identity: watermarkIdentity,
        metadata: {
          channel: transaction.channel || null,
          institution_share_kobo: split.institutionShareKobo,
          provider_share_kobo: split.providerShareKobo,
        },
      },
    },
  );

  return jsonResponse({
    success: true,
    guest: true,
    order,
    signed_url: signedUrl,
    expires_in: SIGNED_URL_TTL_SECONDS,
    watermark_identity: watermarkIdentity,
    watermarked: true,
    project: publicProject(project),
  });
}

async function initializeDownloadPayment(
  supabaseUrl: string,
  serviceRoleKey: string,
  paystackSecret: string,
  user: User,
  profile: Profile,
  body: Record<string, unknown>,
) {
  if (!user.email && !profile.email) {
    return jsonResponse({ error: "Authenticated user has no email address" }, 400);
  }

  const projectId = requireString(body.project_id, "project_id");
  const [project] = await getPublishedProject(supabaseUrl, serviceRoleKey, projectId);
  if (!project) return jsonResponse({ error: "Published project not found" }, 404);
  const tenantError = assertProjectTenant(profile, project);
  if (tenantError) return tenantError;

  const existingUnlock = await getUnlock(supabaseUrl, serviceRoleKey, profile.id, project.id);
  if (existingUnlock) {
    const signedUrl = await createWatermarkedDownloadUrl(
      supabaseUrl,
      serviceRoleKey,
      project,
      existingUnlock.watermark_identity,
    );
    return jsonResponse({
      success: true,
      already_unlocked: true,
      signed_url: signedUrl,
      expires_in: SIGNED_URL_TTL_SECONDS,
      watermark_identity: existingUnlock.watermark_identity,
      watermarked: true,
      project: publicProject(project),
    });
  }

  const config = await getDownloadConfig(supabaseUrl, serviceRoleKey, project.institution_id);
  const reference = `SPMS-DL-${Date.now()}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  const split = calculateSplit(config.download_fee_kobo, config);
  const payload = buildPaystackInitializePayload({
    email: user.email || profile.email || "",
    amount: config.download_fee_kobo,
    currency: config.currency,
    reference,
    config,
    metadata: {
      payment_type: "repository_download",
      project_id: project.id,
      user_id: profile.id,
      watermark_identity: profile.matric || profile.email || user.email || profile.id,
      institution_share_kobo: split.institutionShareKobo,
      provider_share_kobo: split.providerShareKobo,
    },
  });

  const paystackData = await initializePaystackTransaction(paystackSecret, payload);
  return jsonResponse({
    success: true,
    reference,
    amount: config.download_fee_kobo,
    currency: config.currency,
    access_code: paystackData.access_code,
    authorization_url: paystackData.authorization_url,
    split_applied: describePaystackSplit(payload),
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
    `/projects?id=eq.${encodeURIComponent(projectId)}&status=in.(published,cleared)&select=id,institution_id,title,abstract,degree,file_path,status,departments(name),courses(name)`,
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
      `/system_configs?institution_id=eq.${encodeURIComponent(institutionId)}&select=download_fee_kobo,currency,institution_share_percent,provider_share_percent,paystack_split_code,paystack_institution_subaccount,paystack_provider_subaccount`,
    );
    if (configs[0]) return normalizePaymentConfig(configs[0], DEFAULT_DOWNLOAD_FEE_KOBO);
  }

  return normalizePaymentConfig({}, DEFAULT_DOWNLOAD_FEE_KOBO);
}

function normalizePaymentConfig(config: Record<string, unknown>, defaultFeeKobo: number) {
  const institutionSharePercent = Number(config.institution_share_percent ?? 50);
  const providerSharePercent = Number(config.provider_share_percent ?? (100 - institutionSharePercent));

  return {
    download_fee_kobo: Number(config.download_fee_kobo ?? defaultFeeKobo),
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

async function createSignedUrl(
  supabaseUrl: string,
  serviceRoleKey: string,
  filePath: string,
) {
  const res = await fetch(
    `${supabaseUrl}/storage/v1/object/sign/repository-downloads/${encodeStoragePath(filePath)}`,
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
  if (signedPath.startsWith("http")) return signedPath;
  const relativePath = signedPath.startsWith("/") ? signedPath : `/${signedPath}`;
  const storagePath = relativePath.startsWith("/storage/v1/")
    ? relativePath
    : `/storage/v1${relativePath}`;
  return `${supabaseUrl}${storagePath}`;
}

async function createWatermarkedDownloadUrl(
  supabaseUrl: string,
  serviceRoleKey: string,
  project: Project,
  watermarkIdentity: string,
) {
  const originalBytes = await downloadStorageObject(
    supabaseUrl,
    serviceRoleKey,
    project.file_path,
  );
  const watermarkedBytes = await watermarkPdf(originalBytes, {
    identity: watermarkIdentity,
    projectTitle: project.title,
    projectId: project.id,
  });
  const watermarkedPath = [
    project.institution_id || "global",
    "watermarked-downloads",
    safeStorageSegment(watermarkIdentity),
    `${project.id}-${Date.now()}.pdf`,
  ].join("/");

  await uploadStorageObject(
    supabaseUrl,
    serviceRoleKey,
    watermarkedPath,
    watermarkedBytes,
  );

  return await createSignedUrl(supabaseUrl, serviceRoleKey, watermarkedPath);
}

async function downloadStorageObject(
  supabaseUrl: string,
  serviceRoleKey: string,
  filePath: string,
) {
  const res = await fetch(
    `${supabaseUrl}/storage/v1/object/thesis-pdfs/${encodeStoragePath(filePath)}`,
    {
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
      },
    },
  );

  if (!res.ok) {
    const message = await getErrorMessage(res);
    throw new Error(`Could not read original PDF: ${message}`);
  }

  return new Uint8Array(await res.arrayBuffer());
}

async function uploadStorageObject(
  supabaseUrl: string,
  serviceRoleKey: string,
  filePath: string,
  fileBytes: Uint8Array,
) {
  const res = await fetch(
    `${supabaseUrl}/storage/v1/object/repository-downloads/${encodeStoragePath(filePath)}`,
    {
      method: "POST",
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/pdf",
        "x-upsert": "true",
      },
      body: new Blob([fileBytes.buffer as ArrayBuffer], { type: "application/pdf" }),
    },
  );

  if (!res.ok) {
    const message = await getErrorMessage(res);
    throw new Error(`Could not store watermarked PDF: ${message}`);
  }
}

async function watermarkPdf(
  sourceBytes: Uint8Array,
  details: { identity: string; projectTitle: string; projectId: string },
) {
  const pdfDoc = await PDFDocument.load(sourceBytes, { ignoreEncryption: true });
  const watermarkFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const footerFont = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const issuedAt = new Date().toISOString();
  const identity = details.identity.slice(0, 80);
  const title = details.projectTitle.slice(0, 90);
  const diagonalText = `Licensed to ${identity}`;
  const footerText = `SPMS repository copy | ${identity} | ${issuedAt} | ${details.projectId}`;

  for (const page of pdfDoc.getPages()) {
    const { width, height } = page.getSize();
    const diagonalSize = Math.max(18, Math.min(34, width / 18));
    const diagonalWidth = watermarkFont.widthOfTextAtSize(diagonalText, diagonalSize);
    const footerSize = 7;

    page.drawText(diagonalText, {
      x: Math.max(24, (width - diagonalWidth) / 2),
      y: height / 2,
      size: diagonalSize,
      font: watermarkFont,
      color: rgb(0.45, 0.45, 0.45),
      opacity: 0.16,
      rotate: degrees(-32),
    });

    page.drawText(title, {
      x: 36,
      y: height - 28,
      size: 8,
      font: footerFont,
      color: rgb(0.35, 0.35, 0.35),
      opacity: 0.75,
    });

    page.drawText(footerText.slice(0, 180), {
      x: 36,
      y: 18,
      size: footerSize,
      font: footerFont,
      color: rgb(0.35, 0.35, 0.35),
      opacity: 0.75,
    });
  }

  return await pdfDoc.save();
}

function safeStorageSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "anonymous";
}

function publicProject(project: Project) {
  return {
    id: project.id,
    title: project.title,
    abstract: project.abstract,
    degree: project.degree,
    department_name: project.departments?.name || "Department",
    course_name: project.courses?.name || null,
  };
}

function assertProjectTenant(profile: Profile, project: Project) {
  if (project.institution_id && profile.institution_id !== project.institution_id) {
    return jsonResponse({ error: "Repository record belongs to another institution" }, 403);
  }
  return null;
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

function requireEmail(value: unknown) {
  const email = requireString(value, "email").toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("A valid email address is required");
  }
  return email;
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
  institution_id?: string | null;
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
  courses?: { name?: string | null } | null;
};
