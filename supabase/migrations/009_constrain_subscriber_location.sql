-- The signup panel's location field switched from free text to a fixed
-- dropdown (see src/states.ts / build-view.ts, 2026-09-14): a state
-- abbreviation, "REMOTE", or blank ("any location"). subscribers.location
-- is written directly from the browser via the public anon key (see the
-- "anon can sign up" RLS policy), so - same reasoning as the categories
-- CHECK below it - client-side validation alone isn't a real guarantee;
-- someone could still POST an arbitrary string straight to the REST API.
-- This CHECK is what actually keeps the column restricted to values
-- send-alerts.ts's matchesLocationPref() knows how to match against,
-- rather than silently never-matching (and never alerting) a subscriber
-- whose location ended up being free text from before this change, or a
-- malformed direct-API value going forward.
-- NOT VALID: applies going forward without validating existing rows first.
-- If you tested the signup panel before this change with a free-text
-- location, that row would otherwise fail this migration outright (Postgres
-- validates every existing row when a CHECK is added, by default) - NOT
-- VALID skips that check for rows already in the table, at the cost of not
-- fully guaranteeing every existing row satisfies it. Safe to later run
-- `alter table subscribers validate constraint subscribers_location_check;`
-- once you've confirmed (or cleaned up) any pre-dropdown rows.
alter table subscribers drop constraint if exists subscribers_location_check;
alter table subscribers add constraint subscribers_location_check check (
  location is null or location = 'REMOTE' or location in (
    'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID',
    'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS',
    'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK',
    'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV',
    'WI', 'WY', 'DC'
  )
) not valid;
