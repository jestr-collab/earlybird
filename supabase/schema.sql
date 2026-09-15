-- earlybird phase-2 schema: replaces data/companies.json (as the source of
-- truth for storage - the JSON file stays as your editable input list) and
-- data/seen.json with real persistent tables.
--
-- Run this once in the Supabase SQL editor (Project -> SQL Editor -> New
-- query -> paste -> Run) after creating your project.

create table if not exists companies (
  id uuid primary key default gen_random_uuid(),
  slug text not null,
  name text not null,
  ats text not null check (ats in ('greenhouse', 'lever', 'ashby', 'workday', 'smartrecruiters')),
  created_at timestamptz not null default now(),
  unique (slug, ats)
);

create table if not exists postings (
  id uuid primary key default gen_random_uuid(),
  external_id text not null,
  ats text not null check (ats in ('greenhouse', 'lever', 'ashby', 'workday', 'smartrecruiters')),
  company_id uuid references companies(id),
  company_name text not null,
  title text not null,
  team text,
  location text,
  description_text text,
  url text not null,
  ats_updated_at timestamptz,       -- what the ATS itself reports (not fully trusted)
  is_internship boolean not null,
  classifier_reason text not null,
  is_entry_level boolean not null default false, -- new-grad/entry-level track, mutually exclusive w/ is_internship
  entry_level_reason text,
  categories text[],           -- field/major, e.g. {"engineering", "finance"} - a
                                -- posting can belong to more than one (see
                                -- src/categorize.ts's MAJOR_SIGNALS union)
  category_reason text,        -- which signal(s) tagged it - see src/categorize.ts
  preferred_majors text[],     -- extracted from description text - see src/extract-majors.ts
  first_seen_at timestamptz not null default now(), -- our own ground truth for "posted"
  -- (ats, external_id) is the real dedupe key - this is what data/seen.json
  -- was doing locally, now enforced by the database instead.
  unique (ats, external_id)
);

create index if not exists postings_first_seen_at_idx on postings (first_seen_at desc);
create index if not exists postings_is_internship_idx on postings (is_internship) where is_internship = true;
create index if not exists postings_is_entry_level_idx on postings (is_entry_level) where is_entry_level = true;
-- GIN, not btree - categories is now an array, and every categorize/filter
-- query above (sample-other.ts's .contains, build-view.ts's category
-- filter) is an array-containment check, which only a GIN index can serve
-- efficiently at 88k+ rows.
create index if not exists postings_categories_idx on postings using gin (categories);

-- Backs the email-alert signup panel on view.html (see src/build-view.ts).
-- Written to directly from the browser using the public "anon" key baked
-- into view.html, not through any server - the standard Supabase pattern
-- for a form on a static page with no backend of its own. Safe because of
-- the RLS policy below: anon can INSERT (sign up) but can't SELECT,
-- UPDATE, or DELETE anything directly, so the anon key being public never
-- exposes anyone else's email or lets anon rewrite an existing row - other
-- than the one narrow exception below (confirm_subscriber()).
create table if not exists subscribers (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  -- Requires at least 1 category - re-checked here (not just in
  -- build-view.ts's JS) since client-side validation is trivially
  -- bypassable and this table is writable directly from any browser. No
  -- upper bound - the signup panel doesn't cap how many someone can pick.
  categories text[] not null check (array_length(categories, 1) >= 1),
  -- Optional location preference(s) - a fixed checklist (see
  -- src/states.ts), not free text like the listing's own location filter:
  -- zero or more of "REMOTE" / a state abbreviation, or null for "any
  -- location" (a subscriber can pick more than one). Deliberately NOT free
  -- text here even though the listing filter is - the listing filter is a
  -- live substring search a human reads results from immediately, so
  -- inconsistent location strings are just mildly annoying; an alert
  -- preference is matched by code with nobody watching, so it needs a
  -- closed, predictable set of values (see send-alerts.ts's
  -- matchesLocationPref()) or matching silently breaks.
  location text[],
  -- Which stage(s) they want alerts for - internship, entry-level, or both
  -- (defaults to both; unlike location there's no meaningful "doesn't
  -- matter" case, so this can't be null/empty - see the CHECK below).
  stages text[] not null default array['internship', 'entry-level']::text[]
    check (array_length(stages, 1) >= 1 and stages <@ array['internship', 'entry-level']::text[]),
  -- Double opt-in: a signup only creates an unconfirmed row -
  -- send-alerts.ts never emails anyone until they click the link
  -- send-confirmations.ts sends to confirm_token. Without this, anyone
  -- could type a friend's email into the signup panel and have real alert
  -- emails start landing in that friend's inbox with no consent involved.
  confirmed boolean not null default false,
  confirm_token uuid not null default gen_random_uuid(),
  confirmation_sent_at timestamptz,
  created_at timestamptz not null default now(),
  unique (email)
);

-- Same reasoning as the categories CHECK above: this table is writable
-- directly from the browser via the anon key, so the closed set of
-- location values the checklist emits (see src/states.ts) is enforced here
-- too, not just trusted from the client. <@ ("is contained by") checks
-- every element of the array is one of the listed values. NOT VALID on a
-- fresh install is a no-op (there are no existing rows to skip validating)
-- - kept here anyway so this file matches what migration 010 does to an
-- existing database.
alter table subscribers drop constraint if exists subscribers_location_check;
alter table subscribers add constraint subscribers_location_check check (
  location is null or location <@ array[
    'REMOTE',
    'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID',
    'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS',
    'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK',
    'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV',
    'WI', 'WY', 'DC'
  ]::text[]
) not valid;

create unique index if not exists subscribers_confirm_token_idx on subscribers (confirm_token);

alter table subscribers enable row level security;

-- Postgres has no "create policy if not exists" - drop-then-create is the
-- standard way to make this block safe to run more than once (unlike the
-- tables/indexes above, which all use "if not exists" directly). Without
-- this, re-running schema.sql on a project that already has this policy
-- fails with "policy already exists" instead of being a no-op.
drop policy if exists "anon can sign up" on subscribers;
create policy "anon can sign up" on subscribers
  for insert
  to anon
  with check (true);

-- Lets confirm.html (via the public anon key) confirm exactly the one row
-- whose token matches, without a generic "anon can update subscribers" RLS
-- policy that would let anon rewrite arbitrary columns on arbitrary rows.
-- SECURITY DEFINER runs this as the function's owner, bypassing RLS
-- internally, for this one narrow write only. See migration 011.
create or replace function confirm_subscriber(p_token uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  affected int;
begin
  update subscribers
  set confirmed = true
  where confirm_token = p_token and confirmed = false;
  get diagnostics affected = row_count;
  return affected > 0;
end;
$$;

revoke all on function confirm_subscriber(uuid) from public;
grant execute on function confirm_subscriber(uuid) to anon;

-- Same SECURITY DEFINER pattern, reusing the same confirm_token: every
-- alert email links to unsubscribe.html?token=..., which calls this to
-- delete exactly the one row whose token matches. See migration 013.
create or replace function unsubscribe_subscriber(p_token uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  affected int;
begin
  delete from subscribers where confirm_token = p_token;
  get diagnostics affected = row_count;
  return affected > 0;
end;
$$;

revoke all on function unsubscribe_subscriber(uuid) from public;
grant execute on function unsubscribe_subscriber(uuid) to anon;
