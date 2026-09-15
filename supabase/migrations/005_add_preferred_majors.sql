-- Adds the extracted "preferred majors" list to postings. Free-form text
-- array, not a check-constrained enum like ats/category - these are
-- extracted verbatim from description text (see src/extract-majors.ts), so
-- the values are open-ended by design (whatever majors a company actually
-- named), not a fixed set to validate against.
alter table postings add column if not exists preferred_majors text[];
