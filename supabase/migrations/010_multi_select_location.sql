-- The signup panel's location field went from a single-select dropdown to a
-- checklist (see src/build-view.ts / src/states.ts, 2026-09-14): a
-- subscriber can now check off more than one state (or Remote), not just
-- one. This widens subscribers.location from a single text value to an
-- array of them, and updates the CHECK constraint to match - each element
-- still has to be one of the closed set of values matchesLocationPref()
-- knows how to match against (same reasoning as migration 009), just now
-- applied per-element instead of to the whole column.

alter table subscribers add column location_multi text[];

-- Carry over existing single-value rows as a 1-element array; null stays
-- null ("any location").
update subscribers set location_multi = case when location is null then null else array[location] end;

alter table subscribers drop constraint if exists subscribers_location_check;
alter table subscribers drop column location;
alter table subscribers rename column location_multi to location;

-- <@ ("is contained by") checks every element of location is one of the
-- listed values - the array-typed equivalent of the old single-value IN
-- list. NOT VALID for the same reason as migration 009: don't fail this
-- migration outright over rows already in the table (there shouldn't be any
-- non-conforming ones post-conversion above, but this keeps the same safety
-- margin migration 009 used).
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
