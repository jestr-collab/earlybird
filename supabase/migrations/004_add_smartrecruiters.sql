-- Run this in the Supabase SQL editor. Adds "smartrecruiters" as a valid
-- ats value on both tables - same pattern as 001_add_workday.sql when
-- Workday was added. Without this, fetch:db fails on the first insert of
-- any smartrecruiters company/posting with:
--   "new row for relation \"companies\" violates check constraint
--   \"companies_ats_check\""

alter table companies drop constraint companies_ats_check;
alter table companies add constraint companies_ats_check
  check (ats in ('greenhouse', 'lever', 'ashby', 'workday', 'smartrecruiters'));

alter table postings drop constraint postings_ats_check;
alter table postings add constraint postings_ats_check
  check (ats in ('greenhouse', 'lever', 'ashby', 'workday', 'smartrecruiters'));
