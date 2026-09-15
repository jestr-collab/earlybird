-- Run this in the Supabase SQL editor if you already created the tables
-- from the original schema.sql (which only allowed greenhouse/lever/ashby).
-- Adds "workday" as a valid ats value on both tables.

alter table companies drop constraint companies_ats_check;
alter table companies add constraint companies_ats_check
  check (ats in ('greenhouse', 'lever', 'ashby', 'workday'));

alter table postings drop constraint postings_ats_check;
alter table postings add constraint postings_ats_check
  check (ats in ('greenhouse', 'lever', 'ashby', 'workday'));
