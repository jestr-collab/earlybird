// Handles POST /api/create-checkout-session - called from src/worker.ts,
// not deployed as a standalone Cloudflare Pages Function anymore. See
// worker.ts's top comment for why this moved out of functions/api/: this
// project deploys as a Worker-with-assets (via `npx wrangler deploy`), and
// that deploy mode never picks up a functions/ directory the way classic
// Cloudflare Pages does - functions/api/create-checkout-session.ts sat
// there silently unused (404 on every request) until this got restructured
// as an explicit Worker route instead of relying on Cloudflare's
// auto-detection.
//
// Everything else about this file is unchanged from the original version:
// creates a Stripe Checkout Session for whichever plan (monthly/semester)
// was requested and returns its URL. Setup requirements (Stripe prices,
// env vars) are documented in worker.ts, not repeated per-file here.

import Stripe from "stripe";

export interface Env {
  STRIPE_SECRET_KEY: string;
  STRIPE_PRICE_MONTHLY: string;
  STRIPE_PRICE_SEMESTER: string;
  SITE_URL?: string;
  // Comma-separated list of codes that unlock the 14-day free trial (e.g.
  // "ANNIE14,CAREERCENTER"). No trial by default - a visitor with no code,
  // or an unrecognized one, goes straight to a normal paid subscription
  // (card charged immediately). This is deliberately NOT the same thing as
  // Stripe's built-in promotion codes (which only apply price discounts) -
  // set/change these in the Cloudflare Worker's environment variables, not
  // in the Stripe Dashboard.
  TRIAL_CODES?: string;
}

interface CheckoutRequestBody {
  email: string;
  plan: "monthly" | "semester";
  code?: string;
}

export async function handleCreateCheckoutSession(request: Request, env: Env): Promise<Response> {
  let body: CheckoutRequestBody;
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid request body", 400);
  }

  const { email, plan, code } = body;
  if (!email || !isValidEmail(email)) {
    return jsonError("A valid email is required", 400);
  }
  if (plan !== "monthly" && plan !== "semester") {
    return jsonError('plan must be "monthly" or "semester"', 400);
  }

  // Hard paywall by default (charged immediately) - the 14-day trial is
  // opt-in only, via a recognized code. See Env.TRIAL_CODES above.
  const validCodes = (env.TRIAL_CODES || "")
    .split(",")
    .map((c) => c.trim().toUpperCase())
    .filter(Boolean);
  const hasTrialCode = !!code && validCodes.includes(code.trim().toUpperCase());

  const priceId = plan === "monthly" ? env.STRIPE_PRICE_MONTHLY : env.STRIPE_PRICE_SEMESTER;
  if (!priceId) {
    return jsonError("Billing is not configured yet", 500);
  }

  const stripe = new Stripe(env.STRIPE_SECRET_KEY, { httpClient: Stripe.createFetchHttpClient() });
  const siteUrl = (env.SITE_URL || "https://earlybirdcareer.com").replace(/\/+$/, "");

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      // Explicit rather than left to Stripe's auto-detection: a fresh
      // Stripe account can reject Checkout Session creation with "No valid
      // payment method types for this Checkout Session" until Card is
      // enabled under Settings -> Payment methods. Naming it here means
      // checkout works the moment the secret key + price IDs are right,
      // without also depending on that dashboard toggle.
      payment_method_types: ["card"],
      customer_email: email,
      line_items: [{ price: priceId, quantity: 1 }],
      // Only present when a valid trial code was entered - otherwise this
      // is a normal subscription, charged immediately (hard paywall).
      // webhook.ts already treats subscription.status === "trialing" as
      // is_paid: true (see handleCheckoutCompleted), so a trialing
      // subscriber still gets full Pro access right away when this IS set.
      ...(hasTrialCode ? { subscription_data: { trial_period_days: 14 } } : {}),
      success_url: `${siteUrl}/app.html?checkout=success`,
      cancel_url: `${siteUrl}/app.html?checkout=cancelled`,
      metadata: { plan },
    });

    if (!session.url) {
      return jsonError("Stripe did not return a checkout URL", 502);
    }

    return new Response(JSON.stringify({ url: session.url }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[create-checkout-session] Stripe error:", (err as Error).message);
    return jsonError("Could not start checkout", 502);
  }
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
