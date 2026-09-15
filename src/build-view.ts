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

import { mkdir, writeFile } from "node:fs/promises";
import { getSupabase } from "./db.js";
import { US_STATES, REMOTE_PREF } from "./states.js";

// Written to public/ (not data/) so it's safe to point a static host
// directly at this one folder for deployment - data/ also holds
// companies.json, discovered.json, seen.json and the workday-candidates
// CSVs, none of which should be servable at a public URL just because they
// happen to sit next to view.html. public/ contains only what's meant to be
// deployed, nothing else.
const PUBLIC_DIR = new URL("../public/", import.meta.url);
const VIEW_PATH = new URL("../public/index.html", import.meta.url);
const CONFIRM_PATH = new URL("../public/confirm.html", import.meta.url);
const UNSUBSCRIBE_PATH = new URL("../public/unsubscribe.html", import.meta.url);

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
      .select(
        "title, company_name, ats, categories, category_reason, classifier_reason, is_internship, is_entry_level, entry_level_reason, location, url, first_seen_at, ats_updated_at, preferred_majors"
      )
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

  // The other half of the double opt-in flow (see send-confirmations.ts):
  // the link in that email points at <SITE_URL>/confirm.html, so this file
  // needs to be deployed alongside view.html wherever that ends up hosted.
  const confirmHtml = renderConfirmHtml(supabaseUrl, supabaseAnonKey);
  await writeFile(CONFIRM_PATH, confirmHtml);
  console.log(`Wrote ${CONFIRM_PATH.pathname} — deploy this alongside view.html.`);

  // Linked from the footer of every alert email (see send-alerts.ts) -
  // needs to be deployed alongside view.html/confirm.html for the same
  // reason.
  const unsubscribeHtml = renderUnsubscribeHtml(supabaseUrl, supabaseAnonKey);
  await writeFile(UNSUBSCRIBE_PATH, unsubscribeHtml);
  console.log(`Wrote ${UNSUBSCRIBE_PATH.pathname} — deploy this alongside view.html.`);
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
</header>
<div class="stats">${postings.length.toLocaleString()} open roles tracked, updated continuously</div>

<div class="layout">
<main class="main">
<div class="controls">
  <input id="search" placeholder="Search title or company...">
  <input id="locationFilter" placeholder="Location...">
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
    <h2>Get alerted first</h2>
    <p class="signup-sub">Pick your categories and we'll email you the moment a new posting matches.</p>
    <div class="stage-picker" id="stagePicker">
      <label class="loc-option"><input type="checkbox" value="internship" checked> Internships</label>
      <label class="loc-option"><input type="checkbox" value="entry-level" checked> Entry-level</label>
    </div>
    <div class="category-picker" id="categoryPicker">
      ${categories.map((c) => `<button type="button" class="cat-pill" data-cat="${c}">${c}</button>`).join("\n      ")}
    </div>
    <div class="location-picker" id="locationPicker">
      <label class="loc-option"><input type="checkbox" value="${REMOTE_PREF}"> Remote</label>
      ${US_STATES.map((s) => `<label class="loc-option"><input type="checkbox" value="${s.abbr}"> ${s.name}</label>`).join("\n      ")}
    </div>
    <input id="signupEmail" type="email" placeholder="you@school.edu">
    <button id="signupSubmit" class="signup-btn">Notify me</button>
    <div id="signupMsg" class="signup-msg"></div>
  </div>
</aside>
</div>

<footer class="site-footer">earlybird — built for students hunting for their next internship.</footer>

<script>
const data = ${JSON.stringify(postings)};

// Real-data catch (2026-09-13): this used to bucket the ENTIRE 0-59 minute
// range as "just now", so a posting genuinely 15 minutes old looked
// identical to one 1 minute old. That's a credibility problem for a
// product whose whole pitch is speed - "just now" should mean just now,
// not "sometime in the last hour". Minute-level granularity below 1 hour;
// hour/day buckets are still fine above that (users don't need
// second-level precision on a 3-day-old posting).
function timeAgo(iso) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 2) return "just now";
  if (mins < 60) return mins + "m ago";
  const hrs = Math.floor(diffMs / 3600000);
  if (hrs < 24) return hrs + "h ago";
  return Math.floor(hrs / 24) + "d ago";
}

// first_seen_at is when OUR pipeline discovered the posting - not
// necessarily when the company actually posted it. That's fine once a
// company's been synced regularly, but on a brand-new company's first
// sync, its whole existing backlog gets first_seen_at = right now, which
// would otherwise show a job that's been live for weeks as "just now".
//
// ats_updated_at is the ATS's own reported date, but its precision varies
// by source: Greenhouse/Lever/Ashby give an exact timestamp. Workday only
// gives a relative bucket ("Posted Today", "Posted 3 Days Ago") which
// parseWorkdayPostedOn approximates to a timestamp - notably, "Posted
// Today" maps to the moment of that sync, so a Workday posting can
// legitimately keep showing "posted just now" for hours after a run even
// though it may have gone up earlier that same day. Three tiers, labeled
// honestly rather than presenting all three as equally precise:
//   "posted"   - exact, from Greenhouse/Lever/Ashby
//   "posted ~" - approximate, parsed from Workday's day-level bucket
//   "found"    - no ATS date at all, falling back to our own discovery time
function displayTime(p) {
  if (p.ats_updated_at) {
    return { label: p.ats === "workday" ? "posted ~" : "posted", iso: p.ats_updated_at };
  }
  return { label: "found", iso: p.first_seen_at };
}

// Real-data catch (2026-09-13): a preferred_majors list can run long
// (extractMajors occasionally pulls 5-6 phrases out of one posting, some of
// which are clearly extraction noise rather than real majors - e.g. a
// clearance requirement like "Active Top Secret, Top Secret SCI" bleeding
// in from an adjacent bullet with no period between them). That's a
// separate extraction-quality problem to tune later; this just keeps a
// long list from blowing out the row's height in the meantime.
const MAX_MAJORS_SHOWN = 3;
function formatMajors(majors) {
  if (!majors || majors.length === 0) return '';
  const shown = majors.slice(0, MAX_MAJORS_SHOWN).join(', ');
  const extra = majors.length - MAX_MAJORS_SHOWN;
  return shown + (extra > 0 ? \` + \${extra} more\` : '');
}

function render() {
  const q = document.getElementById('search').value.toLowerCase();
  const loc = document.getElementById('locationFilter').value.toLowerCase();
  const cat = document.getElementById('catFilter').value;
  const stage = document.getElementById('stageFilter').value;
  const filtered = data.filter(p => {
    const matchesQ = !q || p.title.toLowerCase().includes(q) || p.company_name.toLowerCase().includes(q);
    // Free-text partial match, not an exact-match dropdown - location
    // strings are too inconsistent across companies/ATSs ("Remote - USA",
    // "New York, NY", "Hybrid - Austin, TX") for a clean list of options,
    // same reasoning as the title/company search above.
    const matchesLoc = !loc || (p.location && p.location.toLowerCase().includes(loc));
    const matchesCat = !cat || (p.categories && p.categories.includes(cat));
    const postingStage = p.is_internship ? 'internship' : 'entry-level';
    const matchesStage = !stage || postingStage === stage;
    return matchesQ && matchesLoc && matchesCat && matchesStage;
  });
  // Sort by whatever timestamp is actually shown on the row (displayTime's
  // dt.iso), not first_seen_at - the product is built around "newest
  // first", and first_seen_at (when OUR pipeline discovered it) can
  // disagree with the real posted date shown on the row (ats_updated_at),
  // so sorting by the former while displaying the latter produced a list
  // that didn't look sorted at all.
  filtered.sort((a, b) => new Date(displayTime(b).iso) - new Date(displayTime(a).iso));
  document.getElementById('count').textContent = filtered.length + ' shown';
  document.getElementById('list').innerHTML = filtered.map(p => {
    const stageLabel = p.is_internship ? 'internship' : 'entry-level';
    const dt = displayTime(p);
    return \`
    <div class="row">
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
  \`;
  }).join('');
}

document.getElementById('search').addEventListener('input', render);
document.getElementById('locationFilter').addEventListener('input', render);
document.getElementById('catFilter').addEventListener('change', render);
document.getElementById('stageFilter').addEventListener('change', render);
render();

// --- Signup panel ---------------------------------------------------
// Writes straight to Supabase from the browser using the public anon key
// baked in below (not the service role key - see this file's real-data
// catch comment in main()). Safe because of the "anon can sign up" RLS
// policy: that key can only INSERT into subscribers, never read/modify
// anyone else's row.
const SUPABASE_URL = ${JSON.stringify(supabaseUrl ?? null)};
const SUPABASE_ANON_KEY = ${JSON.stringify(supabaseAnonKey ?? null)};
const subscribeClient = (SUPABASE_URL && SUPABASE_ANON_KEY && window.supabase)
  ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  : null;

let selectedCats = [];

function renderCategoryPicker() {
  document.querySelectorAll('.cat-pill').forEach(btn => {
    btn.classList.toggle('selected', selectedCats.includes(btn.dataset.cat));
  });
}

document.querySelectorAll('.cat-pill').forEach(btn => {
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

function showSignedUp() {
  document.getElementById('signupCard').innerHTML = \`
    <div class="signup-confirm">
      <div class="signup-confirm-check">✓</div>
      <div class="signup-confirm-title">Almost there</div>
      <div class="signup-confirm-sub">We'll email you a confirmation link shortly. Click it to start getting alerts - until then, nothing will be sent.</div>
    </div>
  \`;
}

document.getElementById('signupSubmit').addEventListener('click', async () => {
  const msgEl = document.getElementById('signupMsg');
  const btn = document.getElementById('signupSubmit');
  const email = document.getElementById('signupEmail').value.trim();
  // locationPicker is now a checklist (Remote + 50 states+DC) instead of a
  // single-value <select> - a subscriber can check off more than one, and
  // the checked values (already a fixed set: REMOTE_PREF or a state abbr)
  // get sent as an array, matching what states.ts's matchesLocationPref()
  // now expects on the alert-sending side (an OR across the array).
  const locations = Array.from(document.querySelectorAll('#locationPicker input:checked')).map(el => el.value);
  // Both boxes are checked by default - most people want both internship
  // and entry-level alerts, and requiring them to opt in to something most
  // people want by default would just be friction. Still validated below
  // (a subscriber can uncheck both, which the DB's CHECK constraint also
  // rejects - see migrations/012_add_subscriber_stages.sql) since "neither"
  // isn't a meaningful preference the way "any location" is.
  const stages = Array.from(document.querySelectorAll('#stagePicker input:checked')).map(el => el.value);
  const emailOk = /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email);

  msgEl.className = 'signup-msg error';

  if (!subscribeClient) {
    msgEl.textContent = "Signups aren't set up yet - check back soon.";
    return;
  }
  if (stages.length === 0) {
    msgEl.textContent = 'Pick internships, entry-level, or both.';
    return;
  }
  if (selectedCats.length === 0) {
    msgEl.textContent = 'Pick at least 1 category above.';
    return;
  }
  if (!emailOk) {
    msgEl.textContent = 'Enter a valid email.';
    return;
  }

  msgEl.textContent = '';
  btn.disabled = true;
  btn.textContent = 'Submitting...';

  // location is optional - nothing checked means "any location", so it's
  // sent as null rather than an empty array (keeps the column meaningfully
  // "unset" for anything that later reads it, e.g. matching alerts).
  const { error } = await subscribeClient.from('subscribers').insert({
    email,
    categories: selectedCats,
    location: locations.length ? locations : null,
    stages,
  });

  if (error) {
    // 23505 = unique_violation - they already signed up, which is a fine
    // outcome (not a real error), so treat it the same as success rather
    // than showing an error for something harmless.
    if (error.code === '23505') {
      showSignedUp();
      return;
    }
    btn.disabled = false;
    btn.textContent = 'Notify me';
    msgEl.textContent = 'Something went wrong - try again in a moment.';
    return;
  }

  showSignedUp();
});
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

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
