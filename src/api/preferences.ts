// Handles POST /api/update-preferences - called from src/worker.ts. Lets a
// Pro subscriber change which categories they get email alerts for, from
// the "Edit categories" control in the Pro sidebar card (public/app.html,
// via build-view.ts). Authenticated the same way /api/postings-full is -
// the login_token IS the credential, no separate session/cookie - so this
// can only ever touch the one subscriber row that token belongs to.
// Deliberately does NOT accept or touch email - that's fixed at signup/
// checkout time and isn't editable here.

import { createClient } from "@supabase/supabase-js";

export interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
}

const VALID_STAGES = ["internship", "entry-level"];

interface UpdatePreferencesBody {
  login: string;
  categories: string[];
  // Optional so older clients (or a request that only wants to change
  // categories) don't have to send it - when omitted, stages is left
  // untouched.
  stages?: string[];
}

export async function handleUpdatePreferences(request: Request, env: Env): Promise<Response> {
  let body: UpdatePreferencesBody;
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid request body", 400);
  }

  const token = body.login?.trim();
  if (!token) {
    return jsonError("Missing login token", 401);
  }

  const categories = Array.isArray(body.categories)
    ? Array.from(new Set(body.categories.filter((c): c is string => typeof c === "string" && c.length > 0)))
    : [];
  if (categories.length === 0) {
    return jsonError("Pick at least 1 category", 400);
  }

  // Same sanitize-and-dedupe treatment as categories, but also constrained
  // to the two values the DB's CHECK constraint allows (see
  // send-alerts.ts's SubscriberRow comment). undefined means "don't touch
  // stages this request" - distinct from an empty array, which is rejected.
  let stages: string[] | undefined;
  if (body.stages !== undefined) {
    stages = Array.isArray(body.stages)
      ? Array.from(new Set(body.stages.filter((s): s is string => VALID_STAGES.includes(s))))
      : [];
    if (stages.length === 0) {
      return jsonError("Pick at least 1 stage (internship and/or entry-level)", 400);
    }
  }

  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

  const { data: subscriber, error: subError } = await supabase
    .from("subscribers")
    .select("id, is_paid, login_token_expires_at")
    .eq("login_token", token)
    .maybeSingle();

  if (subError) {
    console.error("[update-preferences] subscriber lookup failed:", subError.message);
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

  const updatePayload: { categories: string[]; stages?: string[] } = { categories };
  if (stages !== undefined) updatePayload.stages = stages;

  const { error: updateError } = await supabase.from("subscribers").update(updatePayload).eq("id", subscriber.id);

  if (updateError) {
    console.error("[update-preferences] update failed:", updateError.message);
    return jsonError("Could not save your preferences", 500);
  }

  return new Response(JSON.stringify({ ok: true, categories, ...(stages !== undefined ? { stages } : {}) }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
