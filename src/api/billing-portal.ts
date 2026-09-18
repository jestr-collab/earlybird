// Handles POST /api/create-portal-session - called from src/worker.ts,
// backing account.html's "Manage billing" button. Creates a Stripe Billing
// Portal session for the subscriber's stripe_customer_id and returns its
// URL for the client to redirect to. The portal itself (hosted entirely by
// Stripe) is where a subscriber updates their card, views invoices, or
// cancels - this is the self-serve cancellation path (FTC click-to-cancel
// compliance), not something this app implements itself.
//
// One-time manual setup required: the Customer Portal must be activated (and
// optionally configured - what a customer is allowed to do in it) in the
// Stripe Dashboard under Settings -> Billing -> Customer portal, in BOTH
// test and live mode. Without that, session creation below fails with a
// Stripe error telling you exactly this.
//
// Same login_token auth model as postings.ts/preferences.ts/account.ts.

import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

export interface Env {
  STRIPE_SECRET_KEY: string;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  SITE_URL?: string;
}

interface PortalRequestBody {
  login: string;
}

export async function handleCreatePortalSession(request: Request, env: Env): Promise<Response> {
  let body: PortalRequestBody;
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid request body", 400);
  }

  const token = body.login?.trim();
  if (!token) {
    return jsonError("Missing login token", 401);
  }

  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

  const { data: subscriber, error: subError } = await supabase
    .from("subscribers")
    .select("is_paid, login_token_expires_at, stripe_customer_id")
    .eq("login_token", token)
    .maybeSingle();

  if (subError) {
    console.error("[create-portal-session] subscriber lookup failed:", subError.message);
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
  if (!subscriber.stripe_customer_id) {
    return jsonError("No billing account on file for this subscriber", 400);
  }

  const stripe = new Stripe(env.STRIPE_SECRET_KEY, { httpClient: Stripe.createFetchHttpClient() });
  const siteUrl = (env.SITE_URL || "https://earlybirdcareer.com").replace(/\/+$/, "");

  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: subscriber.stripe_customer_id,
      return_url: `${siteUrl}/account.html`,
    });
    return new Response(JSON.stringify({ url: session.url }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[create-portal-session] Stripe error:", (err as Error).message);
    return jsonError("Could not open billing portal", 502);
  }
}

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
