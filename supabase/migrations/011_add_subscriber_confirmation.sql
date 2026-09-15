-- Double opt-in for signups (2026-09-14): without this, anyone could type a
-- friend's email into the signup panel on the listing page and have real
-- alert emails start landing in that friend's inbox with no consent
-- involved - the signup panel writes straight to Supabase from the browser
-- with the public anon key, so there was nothing verifying the entered
-- email actually belonged to the person submitting it.
--
-- A signup now only creates an UNconfirmed row. send-alerts.ts only alerts
-- confirmed = true subscribers. A row becomes confirmed only when someone
-- clicks the link sent by send-confirmations.ts (confirm.html?token=...),
-- which proves they actually control that inbox.

alter table subscribers add column if not exists confirmed boolean not null default false;
alter table subscribers add column if not exists confirm_token uuid not null default gen_random_uuid();
alter table subscribers add column if not exists confirmation_sent_at timestamptz;

create unique index if not exists subscribers_confirm_token_idx on subscribers (confirm_token);

-- A SECURITY DEFINER function instead of a plain RLS UPDATE policy: the
-- public anon key (baked into confirm.html the same way it's baked into
-- view.html's signup panel) needs to be able to flip confirmed to true on
-- exactly the one row whose token matches - without ever being able to
-- UPDATE arbitrary columns on arbitrary subscriber rows, which is what a
-- generic "anon can update" RLS policy would allow. Possessing the token
-- (delivered only via the confirmation email) is the proof of ownership;
-- this function does nothing beyond that one narrow write, and runs as the
-- function owner (bypassing RLS internally) rather than as the calling
-- anon role.
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
