// Handles POST /api/request-login - called from src/worker.ts. Lets a paid
// subscriber get a fresh magic link if their original 30-day login_token
// (issued by the Stripe webhook at checkout time - see src/api/webhook.ts)
// expired or got lost. Deliberately gives the same "check your inbox"
// response whether or not the email matches a paying subscriber, so this
// can't be used to probe which emails are paying customers.

import { createClient } from "@supabase/supabase-js";

export interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  RESEND_API_KEY?: string;
  SITE_URL?: string;
}

interface RequestLoginBody {
  email: string;
}

const SAME_RESPONSE = new Response(
  JSON.stringify({ ok: true, message: "If that email has an active subscription, a login link is on its way." }),
  { status: 200, headers: { "Content-Type": "application/json" } }
);

export async function handleRequestLogin(request: Request, env: Env): Promise<Response> {
  let body: RequestLoginBody;
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid request body", 400);
  }

  const email = body.email?.trim();
  if (!email || !isValidEmail(email)) {
    return jsonError("A valid email is required", 400);
  }

  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

  const { data: subscriber, error: lookupError } = await supabase
    .from("subscribers")
    .select("id, is_paid")
    .eq("email", email)
    .maybeSingle();

  if (lookupError) {
    console.error("[request-login] lookup failed:", lookupError.message);
    // Still return the generic response - a DB hiccup here shouldn't leak
    // anything about whether the email exists, and the subscriber can just
    // try again in a moment.
    return SAME_RESPONSE;
  }

  if (!subscriber || !subscriber.is_paid) {
    return SAME_RESPONSE;
  }

  const loginToken = crypto.randomUUID();
  const loginTokenExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

  const { error: updateError } = await supabase
    .from("subscribers")
    .update({ login_token: loginToken, login_token_expires_at: loginTokenExpiresAt })
    .eq("id", subscriber.id);

  if (updateError) {
    console.error("[request-login] token update failed:", updateError.message);
    return SAME_RESPONSE;
  }

  await sendLoginLinkEmail(email, loginToken, env);

  return SAME_RESPONSE;
}

async function sendLoginLinkEmail(email: string, loginToken: string, env: Env): Promise<void> {
  if (!env.RESEND_API_KEY) {
    console.log(`[request-login] RESEND_API_KEY not set - skipping login-link email for ${email}`);
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
        subject: "Your earlybird Pro login link",
        html: `<p>Here's your link to the full earlybird listing: <a href="${loginUrl}">${loginUrl}</a></p><p>This link works for 30 days.</p>`,
      }),
    });
    if (!res.ok) {
      console.error(`[request-login] Resend rejected send to ${email}: ${res.status}`);
    }
  } catch (err) {
    console.error(`[request-login] failed to send login link to ${email}:`, (err as Error).message);
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
