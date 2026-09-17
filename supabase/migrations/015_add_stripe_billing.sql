-- Real paywall billing (2026-09-16): backs the $19/month and $49/3-month
-- ("semester") plans. Both are true recurring Stripe subscriptions - the
-- semester price uses interval: month, interval_count: 3 - not one-time
-- charges, so a subscriber who forgets to cancel keeps paying automatically
-- instead of silently churning off a one-time purchase. See the chat for
-- the full reasoning; the Stripe dashboard setup steps for creating both
-- prices are in the README/setup notes, not here.
--
-- Trust model note, since it's a real departure from every other column on
-- this table: categories/location/stages/confirmed are all writable by the
-- anon key straight from the browser (see migrations 006-013), because
-- there was no backend at all - the SECURITY DEFINER functions were the
-- only way to let a browser make one narrow, provable write. These columns
-- are different. They are written ONLY by the Stripe webhook handler,
-- running server-side with the service-role key. There is deliberately no
-- RLS policy anywhere granting anon write access to any of this - the
-- webhook (which only Stripe itself calls, and which verifies Stripe's
-- signature before touching anything) is the one thing that should ever be
-- able to say "this subscriber has paid."
alter table subscribers add column if not exists stripe_customer_id text;
alter table subscribers add column if not exists stripe_subscription_id text;
alter table subscribers add column if not exists plan text check (plan in ('monthly', 'semester'));
alter table subscribers add column if not exists is_paid boolean not null default false;
-- When the current billing period actually ends, per Stripe - this is what
-- access checks compare against, not is_paid alone, so a canceled
-- subscription still keeps access through the period the subscriber
-- already paid for instead of cutting them off mid-period.
alter table subscribers add column if not exists current_period_end timestamptz;

create unique index if not exists subscribers_stripe_customer_id_idx
  on subscribers (stripe_customer_id) where stripe_customer_id is not null;
create unique index if not exists subscribers_stripe_subscription_id_idx
  on subscribers (stripe_subscription_id) where stripe_subscription_id is not null;

-- Login/session token - separate from confirm_token (migration 011).
-- confirm_token proves "this inbox opted into free alerts," once, at
-- signup. login_token is a different, repeatable credential: a magic link
-- a PAID subscriber uses to view the gated listing, issued fresh each time
-- they ask for one (no password, same no-password design as the rest of
-- this product). Kept as its own column rather than reusing confirm_token
-- so free-alert confirmation and paid-listing access stay two genuinely
-- separate proofs - a free subscriber's confirm_token should never
-- accidentally unlock paid content, and vice versa.
alter table subscribers add column if not exists login_token uuid;
alter table subscribers add column if not exists login_token_expires_at timestamptz;

create unique index if not exists subscribers_login_token_idx
  on subscribers (login_token) where login_token is not null;

-- No new SECURITY DEFINER function in this migration, on purpose. Every
-- prior one (confirm_subscriber, unsubscribe_subscriber) exists to let the
-- anon key make one narrow write with no backend involved. The "send me a
-- login link" flow doesn't need that trick: it already has to go through a
-- real server endpoint (to send the email via Resend), so that endpoint can
-- just use the service-role key directly rather than routing through
-- another RLS workaround. See the paywall API build notes for that piece.
