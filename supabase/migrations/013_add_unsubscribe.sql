-- Unsubscribe (2026-09-14): every alert email now links to
-- unsubscribe.html?token=<confirm_token> in its footer. Reuses the same
-- confirm_token already on each subscriber (see migration 011) rather than
-- adding a second token column - it's already unguessable and unique per
-- subscriber, and "prove you're the person this email was sent to" is
-- exactly the same requirement confirming and unsubscribing both have.
--
-- Same SECURITY DEFINER pattern as confirm_subscriber(): the public anon
-- key (baked into unsubscribe.html) can call this function to delete
-- exactly the one row whose token matches, without a generic "anon can
-- delete from subscribers" RLS policy that would let anon delete arbitrary
-- rows.
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
