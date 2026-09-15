-- Removes the 2-category cap on subscribers.categories - see
-- build-view.ts's signup panel, which no longer limits how many category
-- pills someone can select. The original check constraint from
-- 006_add_subscribers.sql enforced the same cap at the database level
-- (belt-and-suspenders against the client-side JS limit being bypassed),
-- so it has to be relaxed too, or every signup with 3+ categories would
-- fail with a constraint violation the UI shows as a generic "something
-- went wrong" - the real reason would be invisible.
--
-- Run this once in the Supabase SQL editor, same as the earlier migrations.
alter table subscribers drop constraint if exists subscribers_categories_check;
alter table subscribers add constraint subscribers_categories_check
  check (array_length(categories, 1) >= 1);
