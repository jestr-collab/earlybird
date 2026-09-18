// Handles POST /api/stripe-webhook - called from src/worker.ts. See that
// file's top comment for why this moved out of functions/api/ (this
// project deploys as a Worker-with-assets via `npx wrangler deploy`, which
// never auto-detects a functions/ directory the way classic Cloudflare
// Pages does - the old functions/api/stripe-webhook.ts sat there silently
// unused, 404ing on every real Stripe delivery, until this got
// restructured as an explicit Worker route).
//
// Everything else is unchanged from the original version - see
// supabase/migrations/015_add_stripe_billing.sql's comment for the trust
// model (this is the ONLY thing allowed to mark a subscriber is_paid), and
// the FALLBACK_CATEGORIES comment below for the one real edge case to
// watch for once payments start coming in for real.
const FALLBACK_CATEGORIES = [
  "engineering", "data", "design", "product", "finance", "marketing",
  "sales", "operations", "consulting", "hr", "legal", "science", "other",
];

import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

export interface Env {
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  RESEND_API_KEY?: string;
  SITE_URL?: string;
}

export async function handleStripeWebhook(request: Request, env: Env): Promise<Response> {
  const rawBody = await request.text();
  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    return new Response("Missing stripe-signature header", { status: 400 });
  }

  const stripe = new Stripe(env.STRIPE_SECRET_KEY, { httpClient: Stripe.createFetchHttpClient() });

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
        console.log(`[stripe-webhook] unhandled event type: ${event.type}`);
    }
  } catch (err) {
    // Stripe retries a webhook delivery if it doesn't get a 2xx - returning
    // 500 (not swallowing the error into a 200) is what makes that retry
    // happen, so a transient DB hiccup doesn't silently lose the event.
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

  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const currentPeriodEnd = new Date(subscription.current_period_end * 1000).toISOString();
  const isPaid = subscription.status === "active" || subscription.status === "trialing";
  const loginToken = crypto.randomUUID();
  const loginTokenExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

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
    console.warn(`[stripe-webhook] no existing subscriber row for ${email} - inserting fresh with fallback categories`);
    const { error: insertError } = await supabase.from("subscribers").insert({
      email,
      categories: FALLBACK_CATEGORIES,
      confirmed: true,
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
    console.log(`[stripe-webhook] RESEND_API_KEY not set - skipping login-link email for ${email}`);
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
        from: "earlybird <onboarding@resend.dev>",
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
    console.error(`[stripe-webhook] failed to send login link to ${email}:`, (err as Error).message);
  }
}
