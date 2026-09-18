// Cloudflare Pages Function - lives at /api/stripe-webhook once deployed.
// This is the only thing in the whole product that's allowed to mark a
// subscriber is_paid - see supabase/migrations/015_add_stripe_billing.sql's
// comment on why that's deliberately different from every other column on
// this table (those are anon-writable from the browser; this one isn't,
// anywhere).
//
// STATUS (2026-09-18): scaffolded, not deployed/tested against a real
// webhook yet. Needs, beyond what create-checkout-session.ts already
// needed:
//   1. A webhook endpoint created in the Stripe Dashboard (Developers ->
//      Webhooks -> Add endpoint), URL: https://earlybirdcareer.com/api/stripe-webhook
//      Events to send: checkout.session.completed, customer.subscription.updated,
//      customer.subscription.deleted
//   2. That endpoint's signing secret (starts with "whsec_...") set as
//      STRIPE_WEBHOOK_SECRET in Cloudflare Pages env vars.
//   3. SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY ALSO set as Cloudflare
//      Pages env vars - this function needs its own copy of those, same
//      values as Render's .env, but Cloudflare Pages Functions can't read
//      Render's environment (two totally separate hosts).
//   4. (Optional, same graceful-skip pattern as send-alerts.ts) RESEND_API_KEY
//      as a Cloudflare Pages env var too, if you want the "here's your
//      login link" email to actually send from this function. Without it,
//      payment still gets recorded correctly, just no email goes out - not
//      a silent failure, logged clearly either way.
//
// Real-data catch waiting to happen, flagged now rather than after it bites
// someone: this webhook UPDATES an existing subscribers row matched by
// email - it does NOT create one from nothing, because subscribers.categories
// is NOT NULL with no default (see migration 006/007) and there's no way to
// know someone's category preference from a Stripe payment alone. This only
// works cleanly when checkout happens through the flow the paywall mockup
// already designed: pick categories -> enter email (writes an unconfirmed
// subscribers row via the anon key, same as today's free signup) -> hit
// paywall -> checkout with that same email. If checkout ever gets a path
// that skips the category picker entirely, this falls back to inserting a
// new row with every category (see FALLBACK_CATEGORIES below) rather than
// silently failing - not ideal, but preferable to losing a paying
// customer's webhook event. Revisit once there's a real "no free-alert
// account yet, paying anyway" flow.
const FALLBACK_CATEGORIES = [
  "engineering", "data", "design", "product", "finance", "marketing",
  "sales", "operations", "consulting", "hr", "legal", "science", "other",
];

import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

interface Env {
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  RESEND_API_KEY?: string;
  SITE_URL?: string;
}

export async function onRequestPost(context: { request: Request; env: Env }): Promise<Response> {
  const { request, env } = context;

  // Stripe's signature check needs the EXACT raw request body bytes, not a
  // re-serialized JSON.parse/stringify round trip - even a whitespace
  // difference fails verification. request.text() gives the raw string as
  // received, before anything touches it.
  const rawBody = await request.text();
  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    return new Response("Missing stripe-signature header", { status: 400 });
  }

  // Cloudflare Workers/Pages Functions don't have Node's crypto module, so
  // the Stripe SDK needs its fetch-based HTTP client and the ASYNC webhook
  // constructor (constructEventAsync, not constructEvent) - the sync
  // version depends on Node crypto and throws in this runtime. Easy to
  // miss since Stripe's own docs default to the Node example.
  const stripe = new Stripe(env.STRIPE_SECRET_KEY, {
    httpClient: Stripe.createFetchHttpClient(),
  });

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(rawBody, signature, env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("[stripe-webhook] signature verification failed:", (err as Error).message);
    return new Response("Invalid signature", { status: 400 });
  }

  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        await handleCheckoutCompleted(stripe, supabase, session, env);
        break;
      }
      case "customer.subscription.updated": {
        const subscription = event.data.object as Stripe.Subscription;
        await handleSubscriptionUpdated(supabase, subscription);
        break;
      }
      case "customer.subscription.deleted": {
        const subscription = event.data.object as Stripe.Subscription;
        await handleSubscriptionDeleted(supabase, subscription);
        break;
      }
      default:
        // Stripe sends far more event types than we listen for on the
        // endpoint config above, but a webhook endpoint receives exactly
        // what its own event-type list says - this default case is just a
        // safety net if that list ever changes without this code changing
        // to match, not something that should fire in normal operation.
        console.log(`[stripe-webhook] unhandled event type: ${event.type}`);
    }
  } catch (err) {
    // Real-data catch waiting to happen: Stripe RETRIES a webhook delivery
    // if it doesn't get a 2xx response, so a DB hiccup here isn't lost -
    // Stripe will redeliver the same event later. Returning 500 (not 200)
    // on a processing failure is what makes that retry happen; swallowing
    // the error and returning 200 here would silently lose the event
    // forever the moment Supabase has a bad second.
    console.error(`[stripe-webhook] failed processing ${event.type}:`, (err as Error).message);
    return new Response("Processing error", { status: 500 });
  }

  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

async function handleCheckoutCompleted(
  stripe: Stripe,
  supabase: ReturnType<typeof createClient>,
  session: Stripe.Checkout.Session,
  env: Env
): Promise<void> {
  const email = session.customer_email ?? session.customer_details?.email;
  if (!email) {
    console.error("[stripe-webhook] checkout.session.completed with no email, cannot link to a subscriber");
    return;
  }
  const plan = session.metadata?.plan === "semester" ? "semester" : "monthly";
  const customerId = typeof session.customer === "string" ? session.customer : session.customer?.id;
  const subscriptionId = typeof session.subscription === "string" ? session.subscription : session.subscription?.id;
  if (!customerId || !subscriptionId) {
    console.error(`[stripe-webhook] checkout.session.completed for ${email} missing customer/subscription id`);
    return;
  }

  // The subscription object (not the checkout session) is the source of
  // truth for the actual current_period_end - fetched fresh rather than
  // trusting anything client-suppliable.
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const currentPeriodEnd = new Date(subscription.current_period_end * 1000).toISOString();
  const isPaid = subscription.status === "active" || subscription.status === "trialing";
  const loginToken = crypto.randomUUID();
  const loginTokenExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days

  const { data: updated, error: updateError } = await supabase
    .from("subscribers")
    .update({
      stripe_customer_id: customerId,
      stripe_subscription_id: subscriptionId,
      plan,
      is_paid: isPaid,
      current_period_end: currentPeriodEnd,
      login_token: loginToken,
      login_token_expires_at: loginTokenExpiresAt,
    })
    .eq("email", email)
    .select("id");

  if (updateError) {
    console.error(`[stripe-webhook] update failed for ${email}: ${updateError.message}`);
    throw updateError;
  }

  if (!updated || updated.length === 0) {
    // No existing subscribers row for this email - see the top-of-file
    // comment. Falls back to every category rather than dropping the
    // webhook event, but this is the case worth watching for once real
    // payments start coming in.
    console.warn(`[stripe-webhook] no existing subscriber row for ${email} - inserting fresh with fallback categories`);
    const { error: insertError } = await supabase.from("subscribers").insert({
      email,
      categories: FALLBACK_CATEGORIES,
      confirmed: true, // paying is a stronger proof of a real inbox than the free double opt-in was built for
      stripe_customer_id: customerId,
      stripe_subscription_id: subscriptionId,
      plan,
      is_paid: isPaid,
      current_period_end: currentPeriodEnd,
      login_token: loginToken,
      login_token_expires_at: loginTokenExpiresAt,
    });
    if (insertError) {
      console.error(`[stripe-webhook] fallback insert failed for ${email}: ${insertError.message}`);
      throw insertError;
    }
  }

  await sendLoginLinkEmail(email, loginToken, env);
}

async function handleSubscriptionUpdated(
  supabase: ReturnType<typeof createClient>,
  subscription: Stripe.Subscription
): Promise<void> {
  const isPaid = subscription.status === "active" || subscription.status === "trialing";
  const currentPeriodEnd = new Date(subscription.current_period_end * 1000).toISOString();

  const { error } = await supabase
    .from("subscribers")
    .update({ is_paid: isPaid, current_period_end: currentPeriodEnd })
    .eq("stripe_subscription_id", subscription.id);

  if (error) {
    console.error(`[stripe-webhook] subscription update failed for ${subscription.id}: ${error.message}`);
    throw error;
  }
}

async function handleSubscriptionDeleted(
  supabase: ReturnType<typeof createClient>,
  subscription: Stripe.Subscription
): Promise<void> {
  // Revokes access, doesn't delete the row - unlike the free-alert
  // unsubscribe flow (migration 013), which deletes on purpose since
  // there's nothing else on that row worth keeping. A canceled PAID
  // subscriber's category/location preferences are worth keeping for a
  // potential win-back, so this just flips is_paid off.
  const { error } = await supabase
    .from("subscribers")
    .update({ is_paid: false })
    .eq("stripe_subscription_id", subscription.id);

  if (error) {
    console.error(`[stripe-webhook] subscription delete-handling failed for ${subscription.id}: ${error.message}`);
    throw error;
  }
}

async function sendLoginLinkEmail(email: string, loginToken: string, env: Env): Promise<void> {
  if (!env.RESEND_API_KEY) {
    console.log(`[stripe-webhook] RESEND_API_KEY not set on Cloudflare - skipping login-link email for ${email}`);
    return;
  }
  const siteUrl = (env.SITE_URL || "https://earlybirdcareer.com").replace(/\/+$/, "");
  const loginUrl = `${siteUrl}/app.html?login=${loginToken}`;

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "earlybird <onboarding@resend.dev>", // swap once a verified sending domain is set here too - same caveat as send-alerts.ts
        to: email,
        subject: "You're in - here's your earlybird Pro link",
        html: `<p>Thanks for subscribing! <a href="${loginUrl}">Click here to unlock the full listing</a>.</p><p>This link works for 30 days - come back to this email if you need it again.</p>`,
      }),
    });
    if (!res.ok) {
      console.error(`[stripe-webhook] Resend rejected login-link send to ${email}: ${res.status}`);
      return;
    }
    console.log(`[stripe-webhook] login link sent to ${email}`);
  } catch (err) {
    // Payment is already recorded by this point (the DB write above
    // succeeded) - an email failure here shouldn't roll any of that back
    // or fail the webhook, same "log and move on" pattern as every other
    // email-sending call site in this codebase.
    console.error(`[stripe-webhook] failed to send login link to ${email}:`, (err as Error).message);
  }
}
