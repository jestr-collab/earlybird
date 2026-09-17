// Cloudflare Pages Function - lives at /api/create-checkout-session once
// deployed (Pages Functions route by file path under functions/, same idea
// as Next.js API routes). This is the FIRST piece of the real backend the
// product doesn't have yet - everything before this (fetch pipeline, email
// alerts, the listing page) runs as a static build + a separate cron
// job on Render. This is genuinely new infrastructure: a server that
// responds to a request at request-time, which is what a real paywall
// requires (see the chat - a build-time-baked page can never hide data
// from someone reading its own HTML).
//
// STATUS (2026-09-16): scaffolded, not wired up, not deployed. It will not
// work until:
//   1. The two Stripe prices exist (Stripe Dashboard -> Product catalog ->
//      Add product - create one product "earlybird Pro" with two prices:
//      $19.00 USD recurring every 1 month, and $49.00 USD recurring every
//      3 months. Copy each price's ID - looks like "price_1AbC..." - NOT
//      the product ID.)
//   2. STRIPE_SECRET_KEY and the two price IDs are set as environment
//      variables on the Cloudflare Pages project itself (Pages dashboard ->
//      your project -> Settings -> Environment variables) - this is a
//      SEPARATE environment from Render's, since this function runs on
//      Cloudflare's infrastructure, not Render's. process.env doesn't exist
//      in a Pages Function; everything comes through context.env instead.
//   3. supabase/migrations/015_add_stripe_billing.sql has been run in the
//      Supabase SQL editor (adds the columns this and the webhook handler
//      both need).
//
// Also still needed before checkout is actually usable end-to-end (not in
// this file):
//   - functions/api/stripe-webhook.ts: the endpoint Stripe calls on
//     checkout.session.completed / customer.subscription.updated /
//     customer.subscription.deleted - this is what actually marks a
//     subscriber is_paid and keeps current_period_end accurate over time.
//     Nothing in THIS file writes to the database - creating a Checkout
//     Session doesn't mean payment succeeded yet, only the webhook,
//     confirmed via Stripe's signature, is trustworthy proof of that.
//   - The frontend "Unlock" buttons need to POST { email, plan } here and
//     redirect the browser to the returned url.
//   - functions/api/postings.ts (or similar): the actual gated data
//     endpoint - the piece that makes any of this a real paywall instead
//     of decoration. Not started yet.

import Stripe from "stripe";

interface Env {
  STRIPE_SECRET_KEY: string;
  STRIPE_PRICE_MONTHLY: string; // price_... for the $19/month plan
  STRIPE_PRICE_SEMESTER: string; // price_... for the $49/3-month plan
  SITE_URL: string; // same convention as SITE_URL in send-alerts.ts/send-confirmations.ts
}

interface CheckoutRequestBody {
  email: string;
  plan: "monthly" | "semester";
}

export async function onRequestPost(context: { request: Request; env: Env }): Promise<Response> {
  const { request, env } = context;

  let body: CheckoutRequestBody;
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid request body", 400);
  }

  const { email, plan } = body;
  if (!email || !isValidEmail(email)) {
    return jsonError("A valid email is required", 400);
  }
  if (plan !== "monthly" && plan !== "semester") {
    return jsonError('plan must be "monthly" or "semester"', 400);
  }

  const priceId = plan === "monthly" ? env.STRIPE_PRICE_MONTHLY : env.STRIPE_PRICE_SEMESTER;
  if (!priceId) {
    // Fails loudly rather than silently sending someone to a broken
    // checkout - this only happens if the Cloudflare Pages env vars above
    // haven't been set yet.
    return jsonError("Billing is not configured yet", 500);
  }

  const stripe = new Stripe(env.STRIPE_SECRET_KEY);
  const siteUrl = (env.SITE_URL || "https://earlybirdcareer.com").replace(/\/+$/, "");

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer_email: email,
      line_items: [{ price: priceId, quantity: 1 }],
      // Real success/cancel pages don't exist yet either - placeholders
      // pointing back to the app for now, swap once those pages are built.
      success_url: `${siteUrl}/app.html?checkout=success`,
      cancel_url: `${siteUrl}/app.html?checkout=cancelled`,
      // Tags the session with which plan was chosen and the email entered,
      // so the webhook handler (reading this back off the Stripe event)
      // knows which subscribers row to update without having to guess from
      // Stripe's own customer email alone.
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
