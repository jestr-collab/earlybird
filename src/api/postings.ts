// Handles GET /api/postings-full - called from src/worker.ts. This is the
// ONLY place full posting data (company name, location, apply link,
// preferred majors, category-match reason) ever leaves the server. The
// free/public view (public/app.html, built by build-view.ts) now only ever
// gets the free-safe subset baked in at build time - title, stage,
// categories, and a relative timestamp - so there's nothing to scrape or
// view-source your way around; the real data simply isn't sent to a
// visitor who hasn't proven they're a paying subscriber.
//
// Auth model: the `login` query param is the subscriber's login_token (see
// supabase/migrations/015_add_stripe_billing.sql) - a bearer-token-style
// magic-link credential, not a password. Anyone with a valid, unexpired
// token belonging to a subscriber whose is_paid is true gets the full
// dataset. There's no session/cookie state on the server at all - the
// client (app.html) is responsible for holding onto the token (localStorage)
// and sending it on every request, same pattern as a lot of no-backend
// SaaS magic-link products.

import { createClient } from "@supabase/supabase-js";

export interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
}

export async function handleGetFullPostings(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const token = url.searchParams.get("login");

  if (!token) {
    return jsonError("Missing login token", 401);
  }

  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

  const { data: subscriber, error: subError } = await supabase
    .from("subscribers")
    .select("id, is_paid, login_token_expires_at")
    .eq("login_token", token)
    .maybeSingle();

  if (subError) {
    console.error("[postings-full] subscriber lookup failed:", subError.message);
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

  // Same query build-view.ts used to run for the (now-retired) fully-public
  // snapshot - see that file's git history if the exact prior column list
  // is ever needed again. Paging with .range() for the same reason
  // build-view.ts does: PostgREST caps a single request's rows, and company
  // coverage is well past that cap.
  const PAGE_SIZE = 1000;
  const postings: Record<string, unknown>[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from("postings")
      .select(
        "title, company_name, ats, categories, category_reason, is_internship, is_entry_level, location, url, first_seen_at, ats_updated_at, preferred_majors"
      )
      .or("is_internship.eq.true,is_entry_level.eq.true")
      .order("first_seen_at", { ascending: false })
      .order("id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);

    if (error) {
      console.error("[postings-full] postings fetch failed:", error.message);
      return jsonError("Could not load postings", 500);
    }

    const page = data ?? [];
    postings.push(...page);
    if (page.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  return new Response(JSON.stringify({ postings }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" },
  });
}

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
