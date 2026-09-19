// The product frontend (2026-09-15: promoted from "dead-simple local
// viewer" now that this is what gets deployed - see public/ below).
//
// Pulls internship postings straight from Supabase and writes a single
// self-contained HTML file with the data baked in (no server, no API calls
// from the browser except the signup panel's own Supabase insert - see
// below). That means the deployed page is a SNAPSHOT as of whenever this
// script last ran, not a live view - it needs to be re-run and redeployed
// on a schedule (or switched to a client-side live fetch) to actually stay
// current with a pipeline that's finding new postings every 30 minutes.
// Not fixed here - flagging so it doesn't get assumed away once this is
// live on a real domain.

import { mkdir, writeFile, copyFile } from "node:fs/promises";
import { getSupabase } from "./db.js";
import { US_STATES, REMOTE_PREF } from "./states.js";

// Written to public/ (not data/) so it's safe to point a static host
// directly at this one folder for deployment - data/ also holds
// companies.json, discovered.json, seen.json and the workday-candidates
// CSVs, none of which should be servable at a public URL just because they
// happen to sit next to view.html. public/ contains only what's meant to be
// deployed, nothing else.
const PUBLIC_DIR = new URL("../public/", import.meta.url);
// 2026-09-16: the listing moved off the domain root to make room for a
// hand-written marketing landing page at "/" (see LANDING_SRC/LANDING_PATH
// below) - cold traffic from social/campus marketing needs the pitch first,
// not a raw filterable table with no context. Everything downstream
// (send-alerts.ts, send-confirmations.ts) links to /confirm.html and
// /unsubscribe.html directly and never referenced index.html by name, so
// this rename didn't require touching the email code at all.
const VIEW_PATH = new URL("../public/app.html", import.meta.url);
const CONFIRM_PATH = new URL("../public/confirm.html", import.meta.url);
const UNSUBSCRIBE_PATH = new URL("../public/unsubscribe.html", import.meta.url);
// Standalone account/billing page (2026-09-18) - kept separate from
// app.html's sidebar rather than cramming a "cancel subscription" flow in
// there too. Auth is the same login_token-in-localStorage pattern as
// app.html; see src/api/account.ts and src/api/billing-portal.ts.
const ACCOUNT_PATH = new URL("../public/account.html", import.meta.url);
// The landing page itself is hand-authored, not generated from Supabase
// data, so it lives as a static source file (static/landing.html, tracked
// by git - unlike public/, which is gitignored as a build artifact) and
// just gets copied into place on every build. Editing the landing page
// means editing static/landing.html, never public/index.html directly -
// that file gets overwritten by this script every 30 minutes.
const LANDING_SRC = new URL("../static/landing.html", import.meta.url);
const LANDING_PATH = new URL("../public/index.html", import.meta.url);

// Real-data catch (2026-09-13): this used to be a single query with
// .limit(1000) - which felt generous when it was written, but company
// coverage has grown a lot since (1,373 companies now, several with
// thousands of live postings each), and the very next real run actually
// hit that cap exactly ("Pulled 1000 posting(s)..."). That's not a safe
// margin, it's silent data loss happening right now - postings that exist
// and match is_internship/is_entry_level just never made it into the page,
// with nothing on screen to indicate anything was cut off. PostgREST
// itself caps any single request's rows (commonly 1000), so the fix isn't
// a bigger number, it's paging through with .range() until a page comes
// back short.
const PAGE_SIZE = 1000;

async function fetchAllPostings(supabase: ReturnType<typeof getSupabase>) {
  const postings: Record<string, unknown>[] = [];
  let from = 0;

  while (true) {
    const { data, error } = await supabase
      .from("postings")
      // Real paywall (2026-09-18): this file's output (public/app.html) is
      // served as a public static asset by Cloudflare - anything selected
      // here is downloadable by anyone via view-source, paywall CSS blur or
      // not. So this now ONLY selects the fields the free tier is meant to
      // see: title, stage, categories, and enough to compute a relative
      // timestamp. Company name, location, apply URL, preferred majors, and
      // the category-match reason are deliberately left out - those are
      // fetched live, per-request, only for a caller with a valid paid
      // login_token, by src/api/postings.ts's handleGetFullPostings. See
      // that file for the full auth model.
      .select("title, ats, categories, is_internship, is_entry_level, first_seen_at, ats_updated_at")
      .or("is_internship.eq.true,is_entry_level.eq.true")
      // first_seen_at alone isn't a unique sort key - a company's entire
      // backlog on its first sync all gets the same first_seen_at (down to
      // the second, sometimes exactly, for a big batch insert like Merck's
      // 1,160 or RTX's 4,685). Range-based pagination needs a fully stable
      // order or rows can be skipped or duplicated across page boundaries
      // when many rows share the same timestamp - id as a tiebreaker makes
      // the order deterministic regardless of ties.
      .order("first_seen_at", { ascending: false })
      .order("id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);

    if (error) throw new Error(`build-view fetch failed: ${error.message}`);

    const page = data ?? [];
    postings.push(...page);
    if (page.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  return postings;
}

async function main() {
  const supabase = getSupabase();

  const postings = await fetchAllPostings(supabase);
  const internshipCount = postings.filter((p) => p.is_internship).length;
  console.log(
    `Pulled ${postings.length} posting(s): ${internshipCount} internship, ${postings.length - internshipCount} entry-level.`
  );

  // The signup panel writes straight to Supabase from the browser (see the
  // "anon can sign up" RLS policy in supabase/migrations/006_add_subscribers.sql)
  // using the public anon key - NOT the service role key this script itself
  // uses (SUPABASE_SERVICE_ROLE_KEY, via getSupabase()). The anon key is
  // meant to be public and baked into client-side code; it's the RLS policy,
  // not secrecy of this key, that keeps the subscribers table safe. If it's
  // not set yet, the panel still renders but explains signups aren't live
  // yet instead of silently failing.
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
  if (!supabaseAnonKey) {
    console.warn(
      "SUPABASE_ANON_KEY not set in .env - the signup panel will render but signups will be disabled. Get it from Supabase: Project Settings -> API -> anon/public key."
    );
  }

  await mkdir(PUBLIC_DIR, { recursive: true });

  const html = renderHtml(postings, supabaseUrl, supabaseAnonKey);
  await writeFile(VIEW_PATH, html);
  console.log(`Wrote ${VIEW_PATH.pathname} — open it in your browser.`);

  // Landing page at the domain root - see LANDING_SRC's comment above.
  // Plain copy, not a template render: this page has no dynamic data in it.
  await copyFile(LANDING_SRC, LANDING_PATH);
  console.log(`Wrote ${LANDING_PATH.pathname} (copied from static/landing.html).`);

  // The other half of the double opt-in flow (see send-confirmations.ts):
  // the link in that email points at <SITE_URL>/confirm.html, so this file
  // needs to be deployed alongside view.html wherever that ends up hosted.
  const confirmHtml = renderConfirmHtml(supabaseUrl, supabaseAnonKey);
  await writeFile(CONFIRM_PATH, confirmHtml);
  console.log(`Wrote ${CONFIRM_PATH.pathname} — deploy this alongside app.html.`);

  // Linked from the footer of every alert email (see send-alerts.ts) -
  // needs to be deployed alongside app.html/confirm.html for the same
  // reason.
  const unsubscribeHtml = renderUnsubscribeHtml(supabaseUrl, supabaseAnonKey);
  await writeFile(UNSUBSCRIBE_PATH, unsubscribeHtml);
  console.log(`Wrote ${UNSUBSCRIBE_PATH.pathname} — deploy this alongside app.html.`);

  // Plan/billing management, linked from app.html's Pro sidebar card - see
  // ACCOUNT_PATH's comment above.
  const accountHtml = renderAccountHtml();
  await writeFile(ACCOUNT_PATH, accountHtml);
  console.log(`Wrote ${ACCOUNT_PATH.pathname} — deploy this alongside app.html.`);
}

function renderHtml(
  postings: Record<string, unknown>[],
  supabaseUrl: string | undefined,
  supabaseAnonKey: string | undefined
): string {
  // categories is now an array per posting (a posting can belong to more
  // than one - see categorize.ts) - flatMap instead of map so a posting
  // tagged ["engineering", "data"] contributes to both category-picker
  // buttons/filter options instead of only the first.
  const categories = Array.from(
    new Set(postings.flatMap((p) => (Array.isArray(p.categories) && p.categories.length > 0 ? p.categories.map(String) : ["other"])))
  ).sort();

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>earlybird — internship &amp; new-grad alerts</title>
<meta name="description" content="New internship and entry-level postings from company career pages, surfaced within hours of going live.">
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
<style>
  /* NOTE: intentionally not touching .row/.title/.company/.tags/.cat/.stage/
     .majors/.reason or the listing's rendering logic below - this pass is
     everything AROUND the list (header, chrome, signup panel, page-level
     styling), not the list itself. */
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 1240px; margin: 0 auto; padding: 0 1.5rem 3rem; color: #1a1a1a; background: #fbfbfc; }
  a { color: #06c; text-decoration: none; }
  a:hover { text-decoration: underline; }

  .site-header { display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap; gap: 0.4rem 1.5rem; padding: 1.75rem 0 1.25rem; border-bottom: 1px solid #e8e8ec; margin-bottom: 1.5rem; }
  .brand { display: flex; align-items: center; gap: 0.5rem; font-size: 1.3rem; font-weight: 700; letter-spacing: -0.02em; color: #111; }
  .brand-bird { flex-shrink: 0; display: block; }
  .tagline { color: #777; font-size: 0.85rem; margin: 0; }
  .account-link { font-size: 0.82rem; color: #555; white-space: nowrap; }
  .account-link:hover { color: #06c; }
  .stats { color: #888; font-size: 0.8rem; margin-bottom: 1.25rem; }

  .layout { display: flex; gap: 2rem; align-items: flex-start; }
  .main { flex: 1; min-width: 0; }
  .controls { display: flex; gap: 0.5rem; margin-bottom: 1rem; flex-wrap: wrap; background: #fff; border: 1px solid #eee; border-radius: 10px; padding: 0.65rem; }
  input, select { font-size: 0.9rem; padding: 0.45rem 0.65rem; border: 1px solid #dcdce0; border-radius: 6px; font-family: inherit; background: #fff; }
  input:focus, select:focus { outline: none; border-color: #06c; }
  .controls input { flex: 1; min-width: 140px; }
  .controls #search { flex: 2; min-width: 200px; }
  .row { border-bottom: 1px solid #eee; padding: 0.7rem 0; }
  .row:hover { background: #fafafa; }
  .title { font-weight: 600; }
  .company { color: #444; }
  .tags { font-size: 0.75rem; color: #888; margin-top: 0.2rem; }
  .cat { display: inline-block; background: #eef; color: #337; padding: 0.1rem 0.5rem; border-radius: 4px; margin-right: 0.4rem; }
  .majors { display: inline-block; background: #f3eefc; color: #6a3ea1; padding: 0.1rem 0.5rem; border-radius: 4px; margin-right: 0.4rem; }
  .stage { display: inline-block; padding: 0.1rem 0.5rem; border-radius: 4px; margin-right: 0.4rem; }
  .stage.internship { background: #e6f7ec; color: #1a7a3f; }
  .stage.entry-level { background: #fdf0e0; color: #a15c07; }
  .reason { color: #aaa; }
  #count { font-size: 0.85rem; color: #666; margin-bottom: 0.5rem; }

  /* Signup panel - same visual language as the listing above it (same
     font, same .cat pill shape/colors, same border/radius scale) rather
     than a new style bolted on next to it. */
  .sidebar { width: 300px; flex-shrink: 0; }
  .signup-card { border: 1px solid #eee; border-radius: 12px; padding: 1.3rem; position: sticky; top: 2rem; box-shadow: 0 1px 2px rgba(0,0,0,0.03); }
  .signup-card h2 { font-size: 1rem; margin: 0 0 0.3rem; }
  .signup-sub { font-size: 0.8rem; color: #666; margin: 0 0 0.9rem; line-height: 1.4; }
  .category-picker { display: flex; flex-wrap: wrap; gap: 0.4rem; margin-bottom: 0.9rem; }
  .cat-pill {
    font-size: 0.75rem; background: #eef; color: #337; padding: 0.25rem 0.6rem;
    border-radius: 4px; border: 1px solid transparent; cursor: pointer; font-family: inherit;
  }
  .cat-pill.selected { background: #337; color: #fff; }
  .signup-card input, .signup-card select { width: 100%; box-sizing: border-box; margin-bottom: 0.6rem; font-family: inherit; }
  .signup-btn {
    width: 100%; background: #06c; color: #fff; border: none; border-radius: 6px;
    padding: 0.55rem; font-size: 0.9rem; font-family: inherit; cursor: pointer;
  }
  .signup-btn:disabled { background: #99c2e8; cursor: default; }
  .signup-msg { font-size: 0.78rem; margin-top: 0.6rem; min-height: 1em; }
  .signup-msg.error { color: #b3261e; }
  .signup-hint { font-size: 0.72rem; color: #999; margin-top: 0.5rem; }
  .signup-confirm { text-align: center; padding: 0.5rem 0; }
  .signup-confirm-check {
    width: 32px; height: 32px; line-height: 32px; border-radius: 50%; background: #e6f7ec;
    color: #1a7a3f; font-size: 1rem; margin: 0 auto 0.6rem;
  }
  .signup-confirm-title { font-weight: 600; margin-bottom: 0.3rem; }
  .signup-confirm-sub { font-size: 0.8rem; color: #666; line-height: 1.4; }

  /* Location picker - real checkboxes (not the .cat-pill toggle-button
     pattern the category picker uses) since 51 options as buttons would
     sprawl; a scrollable checklist keeps it compact while still letting
     someone pick more than one. */
  .location-picker {
    max-height: 130px; overflow-y: auto; border: 1px solid #ddd; border-radius: 6px;
    padding: 0.4rem 0.6rem; margin-bottom: 0.6rem; font-size: 0.8rem;
  }
  .loc-option { display: flex; align-items: center; gap: 0.4rem; padding: 0.15rem 0; cursor: pointer; }
  .loc-option input { width: auto; margin: 0; flex-shrink: 0; }
  .stage-picker { display: flex; gap: 1rem; margin-bottom: 0.9rem; font-size: 0.85rem; }

  .site-footer { margin-top: 3rem; padding-top: 1.5rem; border-top: 1px solid #e8e8ec; color: #999; font-size: 0.78rem; text-align: center; }

  /* --- Paywall (2026-09-18) - same treatment as the approved concept
     mockup (Claude outputs/paywall-preview.html): blur + lock on rows,
     no working link, until a valid paid login_token unlocks the full
     dataset client-side. See the script below for the auth flow. */
  .row { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; }
  .row-main { min-width: 0; }
  .posted { color: #999; font-size: 0.75rem; margin-top: 0.1rem; }
  .row-blur { filter: blur(5px); user-select: none; }
  .row-clickable { cursor: pointer; }
  .row-clickable:hover { background: #f3f6fb; }
  .signup-pulse { animation: signup-pulse-anim 0.9s ease-out; }
  @keyframes signup-pulse-anim {
    0% { box-shadow: 0 0 0 0 rgba(0,102,204,0.45); }
    100% { box-shadow: 0 0 0 10px rgba(0,102,204,0); }
  }

  /* Posting-click modal - same "Unlock full access" pitch as the sidebar's
     gated state, but as a real popup (not just a scroll/highlight), since
     that's the more noticeable, unmissable prompt on both desktop (where
     the sidebar is already visible) and mobile (where it's stacked far
     below the fold). */
  .modal-overlay { display: none; position: fixed; inset: 0; background: rgba(20,20,25,0.45); z-index: 1000; align-items: center; justify-content: center; padding: 1rem; }
  .modal-overlay.show { display: flex; }
  .modal-card { background: #fff; border-radius: 12px; padding: 1.5rem; max-width: 340px; width: 100%; position: relative; box-shadow: 0 12px 40px rgba(0,0,0,0.25); }
  .modal-card h3 { margin: 0 0 0.4rem; font-size: 1.05rem; }
  .modal-card p { font-size: 0.82rem; color: #666; margin: 0 0 1rem; line-height: 1.45; }
  .modal-card input { width: 100%; box-sizing: border-box; margin-bottom: 0.7rem; font-family: inherit; }
  .modal-close {
    position: absolute; top: 0.5rem; right: 0.7rem; background: none; border: none;
    font-size: 1.4rem; line-height: 1; color: #999; cursor: pointer; padding: 0.2rem 0.4rem;
  }
  .modal-close:hover { color: #333; }
  .row-lock {
    flex-shrink: 0; display: inline-flex; align-items: center; cursor: pointer;
    background: #f1f1f4; color: #888; font-size: 0.78rem; font-weight: 600;
    padding: 0.4rem 0.8rem; border-radius: 6px; white-space: nowrap; margin-top: 0.1rem; border: none; font-family: inherit;
  }
  .row-lock:hover { background: #e8e8ee; }
  .unlocked-banner {
    background: #e6f7ec; color: #1a7a3f; text-align: center; font-size: 0.82rem;
    padding: 0.5rem 1rem; border-radius: 8px; margin-bottom: 1rem;
  }
  .unlocked-banner.hide, .free-banner.hide { display: none; }
  .free-banner {
    background: #fff3cd; color: #7a5c00; font-size: 0.8rem; line-height: 1.4;
    padding: 0.6rem 0.9rem; border-radius: 8px; margin-bottom: 1rem;
  }

  .signup-gated { text-align: center; display: none; padding: 0.5rem 0; }
  .signup-gated.show { display: block; }
  .signup-gated h3 { font-size: 0.95rem; margin: 0 0 0.4rem; }
  .signup-gated p { font-size: 0.8rem; color: #666; margin: 0 0 1rem; line-height: 1.4; }
  .signup-form.hide { display: none; }
  .plan-picker { display: flex; gap: 0.5rem; margin-bottom: 0.9rem; }
  .plan-option {
    flex: 1; border: 1px solid #dcdce0; border-radius: 8px; padding: 0.6rem 0.5rem;
    cursor: pointer; text-align: center; font-size: 0.8rem; background: #fff;
  }
  .plan-option.selected { border-color: #06c; background: #eef6ff; }
  .plan-option .plan-price { font-weight: 700; font-size: 0.95rem; display: block; }
  .plan-option .plan-period { color: #888; font-size: 0.72rem; }
  .upgrade-btn {
    width: 100%; background: #06c; color: #fff; border: none; border-radius: 6px;
    padding: 0.55rem; font-size: 0.9rem; font-family: inherit; cursor: pointer;
  }
  .upgrade-btn:disabled { background: #99c2e8; cursor: default; }
  .already-sub { text-align: center; margin-top: 0.9rem; font-size: 0.78rem; }
  .already-sub button { background: none; border: none; color: #06c; font-family: inherit; font-size: 0.78rem; cursor: pointer; padding: 0; text-decoration: underline; }
  .login-form { display: none; margin-top: 0.7rem; }
  .login-form.show { display: block; }
  .login-form input { width: 100%; box-sizing: border-box; margin-bottom: 0.5rem; font-family: inherit; }

  /* Shared plain-text button (Pro card's category editing, etc.) - same
     visual language as .already-sub button above, just not scoped to one
     specific container so other panels can use it too. */
  .link-btn { background: none; border: none; color: #06c; font-family: inherit; font-size: 0.78rem; cursor: pointer; padding: 0; text-decoration: underline; }
  .pro-cats-list { font-size: 0.82rem; color: #333; margin: 0 0 0.5rem; line-height: 1.4; }
  .pro-cats-edit { display: none; margin-top: 0.6rem; }
  .pro-cats-edit.show { display: block; }

  @media (max-width: 800px) {
    .layout { flex-direction: column; }
    .sidebar { width: 100%; }
    .signup-card { position: static; }
    .site-header { flex-direction: column; align-items: flex-start; }
  }
</style>
</head>
<body>
<header class="site-header">
  <div class="brand"><svg class="brand-bird" width="26" height="19" viewBox="0 0 28 20" fill="#06c" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><ellipse cx="13" cy="13" rx="7" ry="5"/><circle cx="20" cy="9" r="3.2"/><polygon points="23,8.3 27,7.3 23,10.3"/><polygon points="6,13 1,9 6,16"/><circle cx="20.6" cy="8.2" r="0.7" fill="#fff"/></svg>earlybird</div>
  <p class="tagline">New internship &amp; entry-level postings, the moment they go live.</p>
  <button type="button" id="signInLink" class="account-link" style="background:none; border:none; cursor:pointer;">Sign in</button>
  <a href="/account.html" id="accountLink" class="account-link" style="display:none;">My Account</a>
</header>
<div class="stats" id="stats">${postings.length.toLocaleString()} open roles tracked — titles and posting time are free, full details are Pro</div>

<div class="unlocked-banner hide" id="unlockedBanner">You're on Pro — full listing unlocked.</div>
<div class="free-banner hide" id="expiredBanner">Your Pro link expired or wasn't recognized — showing the free view. <button type="button" class="row-lock" id="requestNewLinkBtn" style="margin-left:0.4rem;">Get a new link</button></div>

<div class="layout">
<main class="main">
<div class="controls">
  <input id="search" placeholder="Search title or company...">
  <input id="locationFilter" placeholder="Location..." class="pro-only" style="display:none;">
  <select id="stageFilter">
    <option value="">Internship + Entry-level</option>
    <option value="internship">Internship only</option>
    <option value="entry-level">Entry-level only</option>
  </select>
  <select id="catFilter">
    <option value="">All categories</option>
    ${categories.map((c) => `<option value="${c}">${c}</option>`).join("\n    ")}
  </select>
</div>
<div id="count"></div>
<div id="list"></div>
</main>

<aside class="sidebar">
  <div class="signup-card" id="signupCard">
    <div class="signup-form" id="signupForm">
      <h2>Get full access</h2>
      <p class="signup-sub">Company, location, apply link, and real-time email alerts are all part of Pro. Pick your categories now, upgrade in a click.</p>
      <div class="category-picker" id="categoryPicker">
        ${categories.map((c) => `<button type="button" class="cat-pill" data-cat="${c}">${c}</button>`).join("\n        ")}
      </div>
      <input id="signupEmail" type="email" placeholder="you@school.edu">
      <button id="signupSubmit" class="signup-btn">Continue</button>
      <div id="signupMsg" class="signup-msg"></div>
    </div>
    <div class="signup-gated" id="signupGated">
      <h3>Unlock full access</h3>
      <p>Full posting details and real-time alerts are part of Pro.</p>
      <div class="plan-picker" id="planPicker">
        <div class="plan-option selected" data-plan="monthly"><span class="plan-price">$19</span><span class="plan-period">per month</span></div>
        <div class="plan-option" data-plan="semester"><span class="plan-price">$49</span><span class="plan-period">per 3 months</span></div>
      </div>
      <button id="upgradeBtn" class="upgrade-btn">Upgrade to Pro</button>
      <div id="upgradeMsg" class="signup-msg"></div>
    </div>
    <div class="already-sub" id="alreadySubWrap">
      <button type="button" id="alreadySubToggle">Already a subscriber? Get your link</button>
      <div class="login-form" id="loginForm">
        <input id="loginEmail" type="email" placeholder="you@school.edu">
        <button id="loginSubmit" class="signup-btn">Email me my link</button>
        <div id="loginMsg" class="signup-msg"></div>
      </div>
    </div>
  </div>
  <div class="signup-card" id="proCard" style="display:none;">
    <p class="signup-sub">Full listing unlocked — company, location, apply links, and real-time email alerts the moment a new posting matches your picks.</p>
    <div id="proCatsView">
      <p class="pro-cats-list">Getting alerts for: <strong id="proCatsList"></strong></p>
      <p class="pro-cats-list">Stage: <strong id="proStagesList"></strong></p>
      <button type="button" class="link-btn" id="proCatsEditBtn">Edit preferences</button>
    </div>
    <div class="pro-cats-edit" id="proCatsEdit">
      <div class="category-picker" id="proCategoryPicker">
        ${categories.map((c) => `<button type="button" class="cat-pill" data-cat="${c}">${c}</button>`).join("\n        ")}
      </div>
      <div class="category-picker" id="proStagePicker" style="margin-top: 0.6rem;">
        <button type="button" class="cat-pill" data-stage="internship">Internship</button>
        <button type="button" class="cat-pill" data-stage="entry-level">Entry-level</button>
      </div>
      <button id="proCatsSaveBtn" class="signup-btn">Save</button>
      <button type="button" class="link-btn" id="proCatsCancelBtn" style="display:block; margin: 0.6rem auto 0;">Cancel</button>
      <div id="proCatsMsg" class="signup-msg"></div>
    </div>
  </div>
</aside>
</div>

<div class="modal-overlay" id="postingModal">
  <div class="modal-card">
    <button type="button" class="modal-close" id="modalClose" aria-label="Close">&times;</button>
    <h3>Unlock full access</h3>
    <p>Company, location, the apply link, and real-time email alerts for this posting (and every match going forward) are part of Pro.</p>
    <input id="modalEmail" type="email" placeholder="you@school.edu">
    <div class="plan-picker" id="modalPlanPicker">
      <div class="plan-option" data-plan="monthly"><span class="plan-price">$19</span><span class="plan-period">per month</span></div>
      <div class="plan-option" data-plan="semester"><span class="plan-price">$49</span><span class="plan-period">per 3 months</span></div>
    </div>
    <button id="modalUpgradeBtn" class="upgrade-btn">Upgrade to Pro</button>
    <div id="modalMsg" class="signup-msg"></div>
  </div>
</div>

<div class="modal-overlay" id="signInModal">
  <div class="modal-card">
    <button type="button" class="modal-close" id="signInModalClose" aria-label="Close">&times;</button>
    <h3>Sign in</h3>
    <p>Enter the email you subscribed with and we'll send you a link to unlock the full listing.</p>
    <input id="signInEmail" type="email" placeholder="you@school.edu">
    <button id="signInSubmitBtn" class="signup-btn">Email me my link</button>
    <div id="signInMsg" class="signup-msg"></div>
  </div>
</div>

<footer class="site-footer">earlybird — built for students hunting for their next internship.</footer>

<script>
// Real paywall (2026-09-18): "data" baked in here is already the free-safe
// subset only (see fetchAllPostings' select() above) - title, stage,
// categories, timestamps. fullData is populated client-side, in-memory
// only (never written to localStorage - only the login TOKEN is), by
// initAuth() below if-and-only-if a valid paid login_token is present.
// render() below picks whichever dataset is active.
const freeData = ${JSON.stringify(postings)};
let fullData = null;
let isPro = false;
// Only set once initAuth() confirms a valid Pro login - used to authenticate
// the "edit alert categories" save call the same way postings-full is
// authenticated (the token IS the credential, no separate session/cookie).
let proLoginToken = null;
let proCategories = [];
let proStages = [];

function currentData() { return (isPro && fullData) ? fullData : freeData; }

function timeAgo(iso) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 2) return "just now";
  if (mins < 60) return mins + "m ago";
  const hrs = Math.floor(diffMs / 3600000);
  if (hrs < 24) return hrs + "h ago";
  return Math.floor(hrs / 24) + "d ago";
}

function displayTime(p) {
  if (p.ats_updated_at) {
    return { label: p.ats === "workday" ? "posted ~" : "posted", iso: p.ats_updated_at };
  }
  return { label: "found", iso: p.first_seen_at };
}

const MAX_MAJORS_SHOWN = 3;
function formatMajors(majors) {
  if (!majors || majors.length === 0) return '';
  const shown = majors.slice(0, MAX_MAJORS_SHOWN).join(', ');
  const extra = majors.length - MAX_MAJORS_SHOWN;
  return shown + (extra > 0 ? \` + \${extra} more\` : '');
}

// Purely a confirmation line ("yep, this is set up correctly") - never used
// for any access decision, which is why postings-full still gates the
// actual data on is_paid server-side regardless of what this displays.
function formatPlanLine(plan, currentPeriodEnd) {
  const planLabel = plan === 'semester' ? 'Semester ($49 / 3 months)' : 'Monthly ($19/mo)';
  let renews = '';
  if (currentPeriodEnd) {
    const d = new Date(currentPeriodEnd);
    if (!isNaN(d.getTime())) {
      renews = ' — renews ' + d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    }
  }
  return '<strong>' + planLabel + ' plan</strong>' + renews;
}

const STAGE_LABELS = { internship: 'Internship', 'entry-level': 'Entry-level' };
function formatStages(stages) {
  if (!stages || stages.length === 0) return '(none selected)';
  return stages.map(s => STAGE_LABELS[s] || s).join(' + ');
}

function renderProCats() {
  document.getElementById('proCatsList').textContent = proCategories.length ? proCategories.join(', ') : '(none selected)';
  document.getElementById('proStagesList').textContent = formatStages(proStages);
}

let proEditSelectedCats = [];
let proEditSelectedStages = [];

function renderProCatPicker() {
  document.querySelectorAll('#proCategoryPicker .cat-pill').forEach(btn => {
    btn.classList.toggle('selected', proEditSelectedCats.includes(btn.dataset.cat));
  });
}

function renderProStagePicker() {
  document.querySelectorAll('#proStagePicker .cat-pill').forEach(btn => {
    btn.classList.toggle('selected', proEditSelectedStages.includes(btn.dataset.stage));
  });
}

document.getElementById('proCatsEditBtn').addEventListener('click', () => {
  proEditSelectedCats = proCategories.slice();
  proEditSelectedStages = proStages.slice();
  renderProCatPicker();
  renderProStagePicker();
  document.getElementById('proCatsMsg').textContent = '';
  document.getElementById('proCatsView').style.display = 'none';
  document.getElementById('proCatsEdit').classList.add('show');
});

document.getElementById('proCatsCancelBtn').addEventListener('click', () => {
  document.getElementById('proCatsEdit').classList.remove('show');
  document.getElementById('proCatsView').style.display = '';
});

document.querySelectorAll('#proCategoryPicker .cat-pill').forEach(btn => {
  btn.addEventListener('click', () => {
    const cat = btn.dataset.cat;
    const idx = proEditSelectedCats.indexOf(cat);
    if (idx >= 0) {
      proEditSelectedCats.splice(idx, 1);
    } else {
      proEditSelectedCats.push(cat);
    }
    renderProCatPicker();
  });
});

document.querySelectorAll('#proStagePicker .cat-pill').forEach(btn => {
  btn.addEventListener('click', () => {
    const stage = btn.dataset.stage;
    const idx = proEditSelectedStages.indexOf(stage);
    if (idx >= 0) {
      proEditSelectedStages.splice(idx, 1);
    } else {
      proEditSelectedStages.push(stage);
    }
    renderProStagePicker();
  });
});

document.getElementById('proCatsSaveBtn').addEventListener('click', async () => {
  const btn = document.getElementById('proCatsSaveBtn');
  const msgEl = document.getElementById('proCatsMsg');
  msgEl.className = 'signup-msg error';
  if (proEditSelectedCats.length === 0) {
    msgEl.textContent = 'Pick at least 1 category.';
    return;
  }
  if (proEditSelectedStages.length === 0) {
    msgEl.textContent = 'Pick at least 1 stage (internship and/or entry-level).';
    return;
  }
  msgEl.textContent = '';
  btn.disabled = true;
  btn.textContent = 'Saving...';
  try {
    const res = await fetch('/api/update-preferences', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login: proLoginToken, categories: proEditSelectedCats, stages: proEditSelectedStages }),
    });
    const responseBody = await res.json();
    if (!res.ok) throw new Error(responseBody.error || 'Could not save');
    // Trust what the server actually saved (it echoes back the sanitized
    // lists) rather than the client's optimistic copy, so any drift shows up
    // immediately instead of silently masking a bug.
    proCategories = Array.isArray(responseBody.categories) ? responseBody.categories : proEditSelectedCats.slice();
    proStages = Array.isArray(responseBody.stages) ? responseBody.stages : proEditSelectedStages.slice();
    renderProCats();
    document.getElementById('proCatsEdit').classList.remove('show');
    document.getElementById('proCatsView').style.display = '';
  } catch (err) {
    msgEl.textContent = err.message || 'Something went wrong - try again in a moment.';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save';
  }
});

function scrollToSignup() {
  const card = document.getElementById('signupCard');
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  // scrollIntoView alone is a no-op on desktop, where the sidebar is
  // already visible next to the listing (side-by-side layout, nothing to
  // scroll to) - so clicking a locked row looked like it did nothing. This
  // pulse + focusing the email field makes the click register visibly
  // whether or not any actual scrolling happens.
  card.classList.remove('signup-pulse');
  // eslint-disable-next-line no-unused-expressions
  void card.offsetWidth; // restart the CSS animation if it's already mid-run
  card.classList.add('signup-pulse');
  const emailInput = document.getElementById('signupEmail');
  if (emailInput && document.getElementById('signupForm') && !document.getElementById('signupForm').classList.contains('hide')) {
    emailInput.focus();
  }
}

function openPostingModal() {
  const overlay = document.getElementById('postingModal');
  overlay.classList.add('show');
  document.getElementById('modalMsg').textContent = '';
  const modalEmailInput = document.getElementById('modalEmail');
  if (pendingEmail && !modalEmailInput.value) modalEmailInput.value = pendingEmail;
  setSelectedPlan(selectedPlan); // sync the modal's plan picker to whatever's already chosen
  modalEmailInput.focus();
}

function closePostingModal() {
  document.getElementById('postingModal').classList.remove('show');
}

// Free rows never receive the real company/location (see fetchAllPostings'
// select() above - it's simply never sent to the browser), so this blurred
// line is a fixed, meaningless placeholder purely for the visual "there's
// something here, and it's locked" effect from the approved mockup - not a
// blurred version of real data. The whole row is clickable (not just a
// separate "Unlock" pill per row, which felt noisy repeated 5,000+ times)
// and scrolls to the Pro signup card, same as the mockup's row-lock click.
const BLURRED_PLACEHOLDER = "Company name · Location";

function freeRowHtml(p) {
  const stageLabel = p.is_internship ? 'internship' : 'entry-level';
  const dt = displayTime(p);
  return \`
    <div class="row row-clickable" onclick="openPostingModal()">
      <div class="row-main">
        <div class="title">\${p.title}</div>
        <div class="company row-blur">\${BLURRED_PLACEHOLDER}</div>
        <div class="posted">\${dt.label} \${timeAgo(dt.iso)}</div>
        <div class="tags">
          <span class="stage \${stageLabel}">\${stageLabel}</span>
          \${(p.categories && p.categories.length ? p.categories : ['other']).map(c => \`<span class="cat">\${c}</span>\`).join('')}
          · <a href="#" onclick="event.stopPropagation(); openPostingModal(); return false;">view posting</a>
        </div>
      </div>
    </div>
  \`;
}

function proRowHtml(p) {
  const stageLabel = p.is_internship ? 'internship' : 'entry-level';
  const dt = displayTime(p);
  return \`
    <div class="row">
      <div class="row-main">
        <div class="title">\${p.title}</div>
        <div class="company">\${p.company_name}\${p.location ? ' · ' + p.location : ''}</div>
        <div class="tags">
          <span class="stage \${stageLabel}">\${stageLabel}</span>
          \${(p.categories && p.categories.length ? p.categories : ['other']).map(c => \`<span class="cat">\${c}</span>\`).join('')}
          \${p.preferred_majors && p.preferred_majors.length ? \`<span class="majors">\${formatMajors(p.preferred_majors)}</span>\` : ''}
          <span>\${dt.label} \${timeAgo(dt.iso)}</span>
          · <a href="\${p.url}" target="_blank">view posting</a>
        </div>
      </div>
    </div>
  \`;
}

function render() {
  const q = document.getElementById('search').value.toLowerCase();
  const loc = document.getElementById('locationFilter').value.toLowerCase();
  const cat = document.getElementById('catFilter').value;
  const stage = document.getElementById('stageFilter').value;
  const filtered = currentData().filter(p => {
    const matchesQ = !q || p.title.toLowerCase().includes(q) || (isPro && p.company_name && p.company_name.toLowerCase().includes(q));
    // Location filtering only makes sense once Pro data (which includes
    // location) is loaded - a free visitor never sees this control (it's
    // display:none until isPro flips true in initAuth()).
    const matchesLoc = !isPro || !loc || (p.location && p.location.toLowerCase().includes(loc));
    const matchesCat = !cat || (p.categories && p.categories.includes(cat));
    const postingStage = p.is_internship ? 'internship' : 'entry-level';
    const matchesStage = !stage || postingStage === stage;
    return matchesQ && matchesLoc && matchesCat && matchesStage;
  });
  filtered.sort((a, b) => new Date(displayTime(b).iso) - new Date(displayTime(a).iso));
  document.getElementById('count').textContent = filtered.length + ' shown';
  document.getElementById('list').innerHTML = filtered.map(p => isPro ? proRowHtml(p) : freeRowHtml(p)).join('');
}

document.getElementById('search').addEventListener('input', render);
document.getElementById('locationFilter').addEventListener('input', render);
document.getElementById('catFilter').addEventListener('change', render);
document.getElementById('stageFilter').addEventListener('change', render);
render();

// --- Pre-payment category picker -------------------------------------
// Kept from the original free-signup design: letting someone pick their
// fields before hitting the paywall gets them invested right before the
// gate. Submitting no longer writes real alert prefs live (alerts are Pro
// now) - it's a best-effort seed (see signupSubmit below) so that if they
// do pay, the Stripe webhook's "match existing row by email" finds their
// real category picks instead of falling back to every category.
const SUPABASE_URL = ${JSON.stringify(supabaseUrl ?? null)};
const SUPABASE_ANON_KEY = ${JSON.stringify(supabaseAnonKey ?? null)};
const subscribeClient = (SUPABASE_URL && SUPABASE_ANON_KEY && window.supabase)
  ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  : null;

let selectedCats = [];
let selectedPlan = 'monthly';
let pendingEmail = null;

function renderCategoryPicker() {
  // Scoped to #categoryPicker (the free-tier signup form's own pills) -
  // previously an unscoped '.cat-pill' selector here also matched the Pro
  // card's "Edit categories" pills (#proCategoryPicker), which share the
  // same class. That meant every click on a Pro category pill ALSO fired
  // this handler and repainted every .cat-pill on the page (Pro card
  // included) based on the free-tier's own unrelated selectedCats array -
  // visually un-highlighting Pro categories the subscriber never touched,
  // right after they clicked something else. That's what looked like
  // "can't remove old categories."
  document.querySelectorAll('#categoryPicker .cat-pill').forEach(btn => {
    btn.classList.toggle('selected', selectedCats.includes(btn.dataset.cat));
  });
}

document.querySelectorAll('#categoryPicker .cat-pill').forEach(btn => {
  btn.addEventListener('click', () => {
    const cat = btn.dataset.cat;
    const idx = selectedCats.indexOf(cat);
    if (idx >= 0) {
      selectedCats.splice(idx, 1);
    } else {
      selectedCats.push(cat);
    }
    renderCategoryPicker();
  });
});

// Shared across BOTH plan pickers (sidebar's #planPicker and the modal's
// #modalPlanPicker) - they use the same data-plan values, so keeping one
// selectedPlan variable and re-syncing every .plan-option element by that
// value (rather than tracking two independent selections) keeps them from
// drifting out of sync with each other.
function setSelectedPlan(plan) {
  selectedPlan = plan;
  document.querySelectorAll('.plan-option').forEach(el => {
    el.classList.toggle('selected', el.dataset.plan === plan);
  });
}
setSelectedPlan(selectedPlan);

document.querySelectorAll('.plan-option').forEach(el => {
  el.addEventListener('click', () => setSelectedPlan(el.dataset.plan));
});

document.getElementById('signupSubmit').addEventListener('click', async () => {
  const msgEl = document.getElementById('signupMsg');
  const email = document.getElementById('signupEmail').value.trim();
  const emailOk = /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email);

  msgEl.className = 'signup-msg error';
  if (selectedCats.length === 0) {
    msgEl.textContent = 'Pick at least 1 category above.';
    return;
  }
  if (!emailOk) {
    msgEl.textContent = 'Enter a valid email.';
    return;
  }
  msgEl.textContent = '';
  pendingEmail = email;

  // Best-effort only - a failure here (including "already exists") should
  // never block getting to the actual upgrade/checkout step below.
  if (subscribeClient) {
    try {
      await subscribeClient.from('subscribers').insert({
        email,
        categories: selectedCats,
        stages: ['internship', 'entry-level'],
        confirmed: false,
      });
    } catch (err) { /* non-fatal - see comment above */ }
  }

  document.getElementById('signupForm').classList.add('hide');
  document.getElementById('signupGated').classList.add('show');
});

// Shared by both the sidebar's upgradeBtn and the posting-click modal's
// modalUpgradeBtn - same request, just reading the email from whichever
// panel the visitor actually used.
async function startCheckout(email, plan, btn, msgEl) {
  msgEl.className = 'signup-msg error';
  if (!email || !/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email)) {
    msgEl.textContent = 'Enter a valid email first.';
    return;
  }

  msgEl.textContent = '';
  const originalLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Redirecting to checkout...';

  try {
    const res = await fetch('/api/create-checkout-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, plan }),
    });
    const responseBody = await res.json();
    if (!res.ok || !responseBody.url) {
      throw new Error(responseBody.error || 'Could not start checkout');
    }
    window.location.href = responseBody.url;
  } catch (err) {
    btn.disabled = false;
    btn.textContent = originalLabel;
    msgEl.textContent = err.message || 'Something went wrong - try again in a moment.';
  }
}

document.getElementById('upgradeBtn').addEventListener('click', () => {
  startCheckout(pendingEmail, selectedPlan, document.getElementById('upgradeBtn'), document.getElementById('upgradeMsg'));
});

document.getElementById('modalUpgradeBtn').addEventListener('click', () => {
  const email = document.getElementById('modalEmail').value.trim();
  pendingEmail = email;
  startCheckout(email, selectedPlan, document.getElementById('modalUpgradeBtn'), document.getElementById('modalMsg'));
});

document.getElementById('modalClose').addEventListener('click', closePostingModal);
document.getElementById('postingModal').addEventListener('click', (e) => {
  if (e.target.id === 'postingModal') closePostingModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closePostingModal(); closeSignInModal(); }
});

// --- "Sign in" (header) - returning Pro subscriber gets a fresh magic link,
// no free-tier signup pitch/category picker in the way. Same
// /api/request-login endpoint as the sidebar's "Already a subscriber?" box -
// just a more direct entry point for someone who's already paying.
function openSignInModal() {
  document.getElementById('signInModal').classList.add('show');
  document.getElementById('signInMsg').textContent = '';
  document.getElementById('signInEmail').focus();
}
function closeSignInModal() {
  document.getElementById('signInModal').classList.remove('show');
}
document.getElementById('signInLink').addEventListener('click', openSignInModal);
document.getElementById('signInModalClose').addEventListener('click', closeSignInModal);
document.getElementById('signInModal').addEventListener('click', (e) => {
  if (e.target.id === 'signInModal') closeSignInModal();
});
document.getElementById('signInSubmitBtn').addEventListener('click', async () => {
  const btn = document.getElementById('signInSubmitBtn');
  const msgEl = document.getElementById('signInMsg');
  const email = document.getElementById('signInEmail').value.trim();

  msgEl.className = 'signup-msg error';
  if (!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email)) {
    msgEl.textContent = 'Enter a valid email.';
    return;
  }
  msgEl.textContent = '';
  btn.disabled = true;
  btn.textContent = 'Sending...';
  try {
    const res = await fetch('/api/request-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const responseBody = await res.json();
    msgEl.className = 'signup-msg';
    msgEl.textContent = responseBody.message || 'Check your inbox for a login link.';
  } catch (err) {
    msgEl.className = 'signup-msg error';
    msgEl.textContent = 'Something went wrong - try again in a moment.';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Email me my link';
  }
});

// --- "Already a subscriber?" - request a fresh magic link -------------
document.getElementById('alreadySubToggle').addEventListener('click', () => {
  document.getElementById('loginForm').classList.toggle('show');
});

document.getElementById('loginSubmit').addEventListener('click', async () => {
  const btn = document.getElementById('loginSubmit');
  const msgEl = document.getElementById('loginMsg');
  const email = document.getElementById('loginEmail').value.trim();

  msgEl.className = 'signup-msg error';
  if (!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email)) {
    msgEl.textContent = 'Enter a valid email.';
    return;
  }

  msgEl.textContent = '';
  btn.disabled = true;
  btn.textContent = 'Sending...';

  try {
    const res = await fetch('/api/request-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const responseBody = await res.json();
    msgEl.className = 'signup-msg';
    msgEl.textContent = responseBody.message || 'Check your inbox for a login link.';
  } catch (err) {
    msgEl.className = 'signup-msg error';
    msgEl.textContent = 'Something went wrong - try again in a moment.';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Email me my link';
  }
});

document.getElementById('requestNewLinkBtn').addEventListener('click', () => {
  document.getElementById('expiredBanner').classList.add('hide');
  document.getElementById('loginForm').classList.add('show');
  scrollToSignup();
});

// --- Login-token bootstrap ---------------------------------------------
// Checks ?login=<token> first (from the magic-link email - see
// src/api/webhook.ts and src/api/login.ts), falling back to whatever's
// saved in localStorage from a previous visit. Only the TOKEN itself is
// persisted client-side - fullData always lives in memory only, re-fetched
// fresh on every page load, so there's no stale/sensitive posting data
// sitting in localStorage.
(async function initAuth() {
  const params = new URLSearchParams(window.location.search);
  let token = params.get('login');
  // Landing page's "Sign in" link sends people here as /app.html?signin=1 -
  // open the sign-in modal directly rather than making them find it again.
  const wantsSignIn = params.has('signin');

  if (token || wantsSignIn) {
    params.delete('login');
    params.delete('signin');
    const cleanQuery = params.toString();
    window.history.replaceState({}, '', window.location.pathname + (cleanQuery ? '?' + cleanQuery : ''));
  }

  if (token) {
    try { localStorage.setItem('earlybird_login_token', token); } catch (err) { /* private browsing etc - fine, just won't persist */ }
  } else {
    try { token = localStorage.getItem('earlybird_login_token'); } catch (err) { token = null; }
  }

  if (!token) {
    if (wantsSignIn) openSignInModal();
    return;
  }

  try {
    const res = await fetch('/api/postings-full?login=' + encodeURIComponent(token));
    if (!res.ok) throw new Error('not authorized');
    const responseBody = await res.json();
    fullData = responseBody.postings;
    isPro = true;
    proLoginToken = token;
    proCategories = Array.isArray(responseBody.categories) ? responseBody.categories : [];
    proStages = Array.isArray(responseBody.stages) && responseBody.stages.length ? responseBody.stages : ['internship', 'entry-level'];
    document.getElementById('unlockedBanner').classList.remove('hide');
    document.getElementById('locationFilter').style.display = '';
    document.getElementById('signupCard').style.display = 'none';
    document.getElementById('proCard').style.display = '';
    document.getElementById('accountLink').style.display = '';
    document.getElementById('signInLink').style.display = 'none';
    renderProCats();
    document.getElementById('stats').textContent = fullData.length.toLocaleString() + ' open roles tracked, updated continuously';
    render();
  } catch (err) {
    try { localStorage.removeItem('earlybird_login_token'); } catch (e2) { /* fine */ }
    document.getElementById('expiredBanner').classList.remove('hide');
  }
})();
</script>
</body>
</html>
`;
}

// Tiny standalone landing page for the confirmation link sent by
// send-confirmations.ts. Reads ?token=... from the URL and calls the
// confirm_subscriber(p_token) Postgres function via RPC (see
// migrations/011_add_subscriber_confirmation.sql) - a SECURITY DEFINER
// function is used instead of a plain RLS update policy so the public anon
// key can flip exactly one boolean on exactly one row (matched by an
// unguessable token) without ever being able to UPDATE arbitrary columns on
// arbitrary subscriber rows.
function renderConfirmHtml(supabaseUrl: string | undefined, supabaseAnonKey: string | undefined): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Confirm your earlybird alerts</title>
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 420px; margin: 4rem auto; padding: 0 1.5rem; color: #1a1a1a; text-align: center; background: #fbfbfc; }
  .brand { display: flex; align-items: center; justify-content: center; gap: 0.5rem; font-size: 1.1rem; font-weight: 700; letter-spacing: -0.02em; color: #111; margin-bottom: 2.5rem; }
  .brand-bird { flex-shrink: 0; display: block; }
  .card { background: #fff; border: 1px solid #eee; border-radius: 12px; padding: 2rem 1.5rem; box-shadow: 0 1px 2px rgba(0,0,0,0.03); }
  .icon { width: 48px; height: 48px; line-height: 48px; border-radius: 50%; font-size: 1.4rem; margin: 0 auto 1rem; }
  .icon.ok { background: #e6f7ec; color: #1a7a3f; }
  .icon.err { background: #fdeceb; color: #b3261e; }
  h1 { font-size: 1.15rem; margin: 0 0 0.5rem; }
  p { color: #666; font-size: 0.9rem; line-height: 1.5; margin: 0; }
  a { color: #06c; }
</style>
</head>
<body>
<div class="brand"><svg class="brand-bird" width="26" height="19" viewBox="0 0 28 20" fill="#06c" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><ellipse cx="13" cy="13" rx="7" ry="5"/><circle cx="20" cy="9" r="3.2"/><polygon points="23,8.3 27,7.3 23,10.3"/><polygon points="6,13 1,9 6,16"/><circle cx="20.6" cy="8.2" r="0.7" fill="#fff"/></svg>earlybird</div>
<div class="card"><div id="status">Confirming...</div></div>
<script>
const SUPABASE_URL = ${JSON.stringify(supabaseUrl ?? null)};
const SUPABASE_ANON_KEY = ${JSON.stringify(supabaseAnonKey ?? null)};
const statusEl = document.getElementById('status');

function show(icon, title, sub) {
  statusEl.innerHTML = \`<div class="icon \${icon}">\${icon === 'ok' ? '✓' : '✕'}</div><h1>\${title}</h1><p>\${sub}</p>\`;
}

async function main() {
  const token = new URLSearchParams(window.location.search).get('token');
  if (!token) {
    show('err', 'Missing confirmation link', 'This link looks incomplete - copy the full link from your email.');
    return;
  }
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !window.supabase) {
    show('err', 'Something went wrong', 'Confirmation isn\\'t available right now - try again in a bit.');
    return;
  }
  const client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { data, error } = await client.rpc('confirm_subscriber', { p_token: token });
  if (error) {
    show('err', 'Something went wrong', 'We couldn\\'t confirm your alerts - try clicking the link again in a moment.');
    return;
  }
  if (data === true) {
    show('ok', "You're confirmed", "You'll get an email the moment a new posting matches your picks.");
  } else {
    show('ok', "Already confirmed", "This link was already used - you're all set, no action needed.");
  }
}

main();
</script>
</body>
</html>
`;
}

// Linked from the footer of every alert email (see send-alerts.ts's
// renderAlertEmail). Deliberately requires an explicit button click rather
// than auto-running on page load the way confirm.html does - unlike
// confirming (harmless if it fires twice, or fires from a link-scanning
// bot's prefetch), unsubscribing is destructive, and a security scanner or
// email client that pre-fetches links in an inbox could otherwise silently
// unsubscribe someone who never even opened the email.
function renderUnsubscribeHtml(supabaseUrl: string | undefined, supabaseAnonKey: string | undefined): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Unsubscribe from earlybird alerts</title>
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 420px; margin: 4rem auto; padding: 0 1.5rem; color: #1a1a1a; text-align: center; background: #fbfbfc; }
  .brand { display: flex; align-items: center; justify-content: center; gap: 0.5rem; font-size: 1.1rem; font-weight: 700; letter-spacing: -0.02em; color: #111; margin-bottom: 2.5rem; }
  .brand-bird { flex-shrink: 0; display: block; }
  .card { background: #fff; border: 1px solid #eee; border-radius: 12px; padding: 2rem 1.5rem; box-shadow: 0 1px 2px rgba(0,0,0,0.03); }
  .icon { width: 48px; height: 48px; line-height: 48px; border-radius: 50%; font-size: 1.4rem; margin: 0 auto 1rem; }
  .icon.ok { background: #e6f7ec; color: #1a7a3f; }
  .icon.err { background: #fdeceb; color: #b3261e; }
  h1 { font-size: 1.15rem; margin: 0 0 0.5rem; }
  p { color: #666; font-size: 0.9rem; line-height: 1.5; margin: 0 0 1.2rem; }
  button { background: #b3261e; color: #fff; border: none; border-radius: 6px; padding: 0.6rem 1.2rem; font-size: 0.9rem; font-family: inherit; cursor: pointer; }
  button:disabled { background: #e5b2ae; cursor: default; }
</style>
</head>
<body>
<div class="brand"><svg class="brand-bird" width="26" height="19" viewBox="0 0 28 20" fill="#06c" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><ellipse cx="13" cy="13" rx="7" ry="5"/><circle cx="20" cy="9" r="3.2"/><polygon points="23,8.3 27,7.3 23,10.3"/><polygon points="6,13 1,9 6,16"/><circle cx="20.6" cy="8.2" r="0.7" fill="#fff"/></svg>earlybird</div>
<div class="card"><div id="status">
  <h1>Unsubscribe from alerts?</h1>
  <p>You'll stop receiving earlybird emails. You can always sign up again later.</p>
  <button id="unsubBtn">Unsubscribe me</button>
</div></div>
<script>
const SUPABASE_URL = ${JSON.stringify(supabaseUrl ?? null)};
const SUPABASE_ANON_KEY = ${JSON.stringify(supabaseAnonKey ?? null)};
const statusEl = document.getElementById('status');

function show(icon, title, sub) {
  statusEl.innerHTML = \`<div class="icon \${icon}">\${icon === 'ok' ? '✓' : '✕'}</div><h1>\${title}</h1><p>\${sub}</p>\`;
}

const token = new URLSearchParams(window.location.search).get('token');

document.getElementById('unsubBtn').addEventListener('click', async () => {
  const btn = document.getElementById('unsubBtn');
  if (!token) {
    show('err', 'Missing link', 'This link looks incomplete - copy the full link from your email.');
    return;
  }
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !window.supabase) {
    show('err', 'Something went wrong', 'Unsubscribing isn\\'t available right now - try again in a bit.');
    return;
  }
  btn.disabled = true;
  btn.textContent = 'Unsubscribing...';
  const client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { data, error } = await client.rpc('unsubscribe_subscriber', { p_token: token });
  if (error) {
    show('err', 'Something went wrong', 'We couldn\\'t unsubscribe you - try clicking the link again in a moment.');
    return;
  }
  if (data === true) {
    show('ok', "You're unsubscribed", "You won't get any more emails from earlybird.");
  } else {
    show('ok', "Already unsubscribed", "This link was already used - nothing more to do.");
  }
});
</script>
</body>
</html>
`;
}

// Standalone account/billing page (2026-09-18) - see ACCOUNT_PATH's comment
// at the top of this file. Uses the same login_token-in-localStorage
// bootstrap as app.html's initAuth(), just simpler: no ?login= URL param
// handling here, since the only way to reach this page is a link FROM
// app.html (which has already saved the token to localStorage by the time
// someone clicks "Manage plan & billing").
function renderAccountHtml(): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Your account — earlybird</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 460px; margin: 4rem auto; padding: 0 1.5rem; color: #1a1a1a; background: #fbfbfc; }
  .brand { display: flex; align-items: center; justify-content: center; gap: 0.5rem; font-size: 1.1rem; font-weight: 700; letter-spacing: -0.02em; color: #111; margin-bottom: 2.5rem; }
  .brand-bird { flex-shrink: 0; display: block; }
  .card { background: #fff; border: 1px solid #eee; border-radius: 12px; padding: 2rem 1.5rem; box-shadow: 0 1px 2px rgba(0,0,0,0.03); text-align: center; }
  h1 { font-size: 1.15rem; margin: 0 0 1.2rem; }
  .row { text-align: left; font-size: 0.88rem; color: #444; padding: 0.6rem 0; border-bottom: 1px solid #f0f0f3; }
  .row:last-of-type { border-bottom: none; }
  .row-label { color: #999; font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.03em; margin-bottom: 0.15rem; }
  .row-value { font-weight: 600; }
  /* Deliberately NOT styled as a primary CTA - this only opens a plain
     confirmation step (see #leavingPanel below), not billing itself, so it
     shouldn't compete visually with "Keep my subscription" there. */
  .manage-link-wrap { margin-top: 1.6rem; text-align: center; }
  .manage-link { background: none; border: none; color: #888; font-family: inherit; font-size: 0.8rem; cursor: pointer; padding: 0; text-decoration: underline; }
  .manage-link:hover { color: #555; }
  .keep-btn {
    width: 100%; background: #06c; color: #fff; border: none; border-radius: 6px;
    padding: 0.65rem; font-size: 0.9rem; font-family: inherit; cursor: pointer; margin-top: 1rem;
  }
  .portal-btn {
    background: none; border: none; color: #888; font-family: inherit; font-size: 0.8rem;
    cursor: pointer; padding: 0; text-decoration: underline; margin-top: 0.9rem;
  }
  .portal-btn:disabled { color: #ccc; cursor: default; }
  .portal-hint { font-size: 0.75rem; color: #999; margin-top: 0.6rem; line-height: 1.4; }
  .acct-msg { font-size: 0.8rem; margin-top: 0.7rem; min-height: 1em; }
  .acct-msg.error { color: #b3261e; }
  .back-link { display: block; margin-top: 1.5rem; font-size: 0.82rem; }
  a { color: #06c; }
</style>
</head>
<body>
<div class="brand"><svg class="brand-bird" width="26" height="19" viewBox="0 0 28 20" fill="#06c" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><ellipse cx="13" cy="13" rx="7" ry="5"/><circle cx="20" cy="9" r="3.2"/><polygon points="23,8.3 27,7.3 23,10.3"/><polygon points="6,13 1,9 6,16"/><circle cx="20.6" cy="8.2" r="0.7" fill="#fff"/></svg>earlybird</div>
<div class="card"><div id="status">Loading your account...</div></div>
<a class="back-link" href="/app.html">&larr; Back to listings</a>
<script>
let currentToken = null;

function formatPlanLabel(plan) {
  return plan === 'semester' ? 'Semester ($49 / 3 months)' : 'Monthly ($19/mo)';
}
function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function showLoaded(info, token) {
  document.getElementById('status').innerHTML = \`
    <h1>Your account</h1>
    <div class="row"><div class="row-label">Email</div><div class="row-value">\${info.email}</div></div>
    <div class="row"><div class="row-label">Plan</div><div class="row-value">\${formatPlanLabel(info.plan)}</div></div>
    <div class="row"><div class="row-label">Renews</div><div class="row-value">\${formatDate(info.currentPeriodEnd)}</div></div>
    <div class="manage-link-wrap">
      <button type="button" class="manage-link" id="openManageBtn">Manage subscription</button>
    </div>
    <div id="leavingPanel" style="display:none;"></div>
  \`;
  document.getElementById('openManageBtn').addEventListener('click', showLeavingPanel);
}

// One honest interstitial before billing/cancellation - not a maze, just a
// single "are you sure, here's an alternative" step (same pattern Netflix,
// Spotify etc. use). "Continue to billing" always stays a plain, reachable
// link, never hidden or disabled - see the ui/legal discussion this came
// from: de-emphasizing is fine, obstructing isn't.
function showLeavingPanel() {
  const token = currentToken;
  document.getElementById('leavingPanel').style.display = 'block';
  document.getElementById('leavingPanel').innerHTML = \`
    <p style="font-size:0.85rem; color:#555; margin: 1.2rem 0 0; line-height:1.4;">Before you go — want to keep your Pro access?</p>
    <button type="button" id="keepBtn" class="keep-btn">Keep my subscription</button>
    <button type="button" id="portalBtn" class="portal-btn">Continue to billing / cancel</button>
    <p class="portal-hint">Update your card, view invoices, or cancel — handled securely by Stripe.</p>
    <div id="acctMsg" class="acct-msg"></div>
  \`;
  document.getElementById('keepBtn').addEventListener('click', () => {
    document.getElementById('leavingPanel').style.display = 'none';
    document.getElementById('leavingPanel').innerHTML = '';
  });
  document.getElementById('portalBtn').addEventListener('click', async () => {
    const btn = document.getElementById('portalBtn');
    const msgEl = document.getElementById('acctMsg');
    msgEl.className = 'acct-msg error';
    msgEl.textContent = '';
    btn.disabled = true;
    btn.textContent = 'Opening billing portal...';
    try {
      const res = await fetch('/api/create-portal-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ login: token }),
      });
      const responseBody = await res.json();
      if (!res.ok || !responseBody.url) throw new Error(responseBody.error || 'Could not open billing portal');
      window.location.href = responseBody.url;
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Continue to billing / cancel';
      msgEl.textContent = err.message || 'Something went wrong - try again in a moment.';
    }
  });
}

function showError(message) {
  document.getElementById('status').innerHTML = \`
    <h1>Your account</h1>
    <p style="color:#666; font-size:0.88rem; line-height:1.5;">\${message}</p>
    <p style="margin-top:1rem;"><a href="/app.html">Go back and request a fresh login link</a></p>
  \`;
}

(async function main() {
  let token = null;
  try { token = localStorage.getItem('earlybird_login_token'); } catch (err) { token = null; }
  if (!token) {
    showError('You need to be signed in as a Pro subscriber to see this page. Head back to the listings and use "Already a subscriber? Get your link" if needed.');
    return;
  }
  currentToken = token;
  try {
    const res = await fetch('/api/account-info?login=' + encodeURIComponent(token));
    if (!res.ok) throw new Error('not authorized');
    const info = await res.json();
    showLoaded(info, token);
  } catch (err) {
    showError('Your login link has expired or wasn\\'t recognized. Head back to the listings and use "Already a subscriber? Get your link" to get a fresh one.');
  }
})();
</script>
</body>
</html>
`;
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
