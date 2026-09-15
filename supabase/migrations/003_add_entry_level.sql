-- Adds the new-grad / entry-level track alongside is_internship. A posting
-- can be one or the other, never both (see src/classify.ts). Run once in
-- the Supabase SQL editor against your existing project.

alter table postings add column if not exists is_entry_level boolean not null default false;
alter table postings add column if not exists entry_level_reason text;

create index if not exists postings_is_entry_level_idx on postings (is_entry_level) where is_entry_level = true;
