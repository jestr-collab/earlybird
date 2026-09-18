// Handles GET /api/account-info - called from src/worker.ts, backing the
// standalone account.html page (see build-view.ts's renderAccountHtml).
// Deliberately a separate, lightweight endpoint rather than reusing
// /api/postings-full - that one returns the entire postings dataset, which
// would be wasteful to fetch just to show an email/plan/renewal summary.
// Same login_token auth model as postings.ts/preferences.ts - see those
// files' top comments for the full explanation.

import { createClient } from "@supabase/supabase-js";

export interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
}

export async function handleGetAccountInfo(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const token = url.searchParams.get("login");

  if (!token) {
    return jsonError("Missing login token", 401);
  }

  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

  const { data: subscriber, error: subError } = await supabase
    .from("subscribers")
    .select("email, is_paid, login_token_expires_at, plan, current_period_end, stripe_customer_id")
    .eq("login_token", token)
    .maybeSingle();

  if (subError) {
    console.error("[account-info] subscriber lookup failed:", subError.message);
    return jsonError("Could not verify access", 500);
  }
  if (!subscriber) {
    return jsonError("Invalid or expired link", 401);
  }
  if (!subscriber.is_paid) {
    return jsonError("This account isn't an active subscriber", 402);
  }
  if (subscriber.login_token_expires_at && new Date(subscriber.login_token_expires_at).getTime() < Date.now()) {
    return jsonError("This login link has expired - request a new one", 401);
  }

  return new Response(
    JSON.stringify({
      email: subscriber.email,
      plan: subscriber.plan ?? null,
      currentPeriodEnd: subscriber.current_period_end ?? null,
      // Just a hint to the client about whether "Manage billing" will work -
      // the actual portal-session creation re-checks this server-side too.
      hasBilling: Boolean(subscriber.stripe_customer_id),
    }),
    { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" } }
  );
}

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
