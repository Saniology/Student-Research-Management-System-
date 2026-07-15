import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const REPOSITORY_FEE_KOBO = 200_000;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-api-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
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

    const supabaseUser = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const {
      data: { user },
      error: userError,
    } = await supabaseUser.auth.getUser();

    if (userError || !user) {
      return jsonResponse({ error: "Unauthorized" }, 401);
    }

    const { reference, file_name, file_path } = await req.json();

    if (!reference || !file_name) {
      return jsonResponse({ error: "Missing payment reference or file name" }, 400);
    }

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

    const { data: existingPayment } = await supabaseAdmin
      .from("payments")
      .select("*")
      .eq("paystack_reference", reference)
      .maybeSingle();

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

    const { data: submission, error: submissionError } = await supabaseAdmin
      .from("submissions")
      .insert({
        student_id: user.id,
        file_name,
        file_path: file_path || null,
        status: "pending",
      })
      .select()
      .single();

    if (submissionError) {
      return jsonResponse({ error: submissionError.message }, 500);
    }

    const { data: payment, error: paymentError } = await supabaseAdmin
      .from("payments")
      .insert({
        student_id: user.id,
        submission_id: submission.id,
        amount: transaction.amount,
        currency: transaction.currency || "NGN",
        paystack_reference: reference,
        paystack_transaction_id: String(transaction.id),
        status: "success",
        paid_at: transaction.paid_at || new Date().toISOString(),
      })
      .select()
      .single();

    if (paymentError) {
      await supabaseAdmin.from("submissions").delete().eq("id", submission.id);
      return jsonResponse({ error: paymentError.message }, 500);
    }

    return jsonResponse({ success: true, payment, submission });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unexpected error";
    return jsonResponse({ error: message }, 500);
  }
});

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
