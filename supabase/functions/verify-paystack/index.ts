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

    const { reference, file_name, file_path } = await req.json();
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

    try {
      const [payment] = await supabaseRest(
        supabaseUrl,
        supabaseServiceKey,
        "/payments?select=*",
        {
          method: "POST",
          body: {
            student_id: user.id,
            submission_id: submission.id,
            amount: transaction.amount,
            currency: transaction.currency || "NGN",
            paystack_reference: reference,
            paystack_transaction_id: String(transaction.id),
            status: "success",
            paid_at: transaction.paid_at || new Date().toISOString(),
          },
        },
      );

      return jsonResponse({ success: true, payment, submission });
    } catch (err) {
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
