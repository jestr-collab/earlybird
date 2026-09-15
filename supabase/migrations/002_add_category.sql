-- Adds field/major category tagging to postings - the piece that actually
-- makes the product filterable (a finance student shouldn't have to wade
-- through Software Engineer Intern listings to find relevant postings).
-- Run this in the Supabase SQL editor.

alter table postings add column if not exists category text;
alter table postings add column if not exists category_reason text;

create index if not exists postings_category_idx on postings (category);
