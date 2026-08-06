const REPOSITORY_FEE_KOBO = 200_000;

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

    const {
      reference,
      file_name,
      file_path,
      title,
      abstract,
      degree,
      file_size_bytes,
    } = await req.json();
    if (!reference || !file_name) {
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

    if (transaction.amount !== REPOSITORY_FEE_KOBO) {
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

    const [profile] = await supabaseRest(
      supabaseUrl,
      supabaseServiceKey,
      `/profiles?id=eq.${encodeURIComponent(user.id)}&select=id,institution_id,department_id,department,supervisor_id,matric`,
    );

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
      const [project] = await supabaseRest(
        supabaseUrl,
        supabaseServiceKey,
        "/projects?select=*",
        {
          method: "POST",
          body: {
            institution_id: profile?.institution_id || null,
            student_id: user.id,
            supervisor_id: profile?.supervisor_id || null,
            department_id: profile?.department_id || null,
            submission_id: submission.id,
            title: projectTitle,
            abstract: typeof abstract === "string" && abstract.trim() ? abstract.trim() : null,
            degree: typeof degree === "string" && degree.trim() ? degree.trim() : null,
            file_name,
            file_path,
            file_size_bytes: Number.isFinite(file_size_bytes) ? file_size_bytes : null,
            mime_type: "application/pdf",
            status: "supervisor_review",
          },
        },
      );
      createdProjectId = project.id;

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
            currency: transaction.currency || "NGN",
            paystack_reference: reference,
            paystack_transaction_id: String(transaction.id),
            status: "success",
            transaction_type: "clearance_fee",
            paid_at: transaction.paid_at || new Date().toISOString(),
            metadata: {
              channel: transaction.channel || null,
              customer_email: transaction.customer?.email || null,
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
            to_status: "supervisor_review",
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

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
