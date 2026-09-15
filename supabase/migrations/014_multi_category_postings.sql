-- Postings can now belong to more than one category (2026-09-14): on top of
-- the existing team/title/company signal, categorize() now also reads
-- preferredMajors (already extracted by extract-majors.ts) and unions in
-- every category each stated major maps to (see categorize.ts's
-- MAJOR_SIGNALS) - e.g. "Computer Science, Data Science, or Statistics"
-- correctly produces {"engineering", "data"} instead of picking just one.
-- This widens postings.category from a single text value to an array of
-- them, same rename-column pattern as migration 010 did for
-- subscribers.location.

alter table postings add column categories_multi text[];

-- Carry over existing single-value rows as a 1-element array; a row that
-- was never classified (category null) becomes an empty array, not null -
-- categorize() itself never returns null, always at least {"other"}, so
-- this keeps the column's meaning consistent post-conversion.
update postings set categories_multi = case when category is null then '{}' else array[category] end;

drop index if exists postings_category_idx;
alter table postings drop column category;
alter table postings rename column categories_multi to categories;

-- GIN, not btree - every category query is now an array-containment check
-- (sample-other.ts's .contains, build-view.ts's category filter), which
-- only a GIN index serves efficiently at 88k+ rows.
create index if not exists postings_categories_idx on postings using gin (categories);
