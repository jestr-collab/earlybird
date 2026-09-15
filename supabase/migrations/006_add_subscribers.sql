-- Backs the email-alert signup panel on view.html (see src/build-view.ts).
-- Run this once in the Supabase SQL editor, same as the earlier migrations.
--
-- This table is written to directly from the browser using the public
-- "anon" key baked into view.html - not through any server we run. That's
-- the standard Supabase pattern for a form on a static page with no
-- backend of its own, and it's safe specifically because of the two RLS
-- policies below: anon can INSERT a row (sign up), but can't SELECT,
-- UPDATE, or DELETE anything - so the anon key being public (which it's
-- designed to be) never exposes anyone else's email or lets a visitor
-- tamper with existing signups.
create table if not exists subscribers (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  -- Enforced client-side too (max 2 - see build-view.ts), but re-checked
  -- here since client-side JS is trivially bypassable and this table is
  -- writable directly from any browser.
  categories text[] not null check (array_length(categories, 1) between 1 and 2),
  created_at timestamptz not null default now(),
  unique (email)
);

alter table subscribers enable row level security;

create policy "anon can sign up" on subscribers
  for insert
  to anon
  with check (true);

-- Deliberately no SELECT/UPDATE/DELETE policy for anon - with RLS enabled
-- and no policy granting those, they're denied by default. Only your own
-- service-role key (used server-side, e.g. for actually sending alerts
-- later) can read this table.
