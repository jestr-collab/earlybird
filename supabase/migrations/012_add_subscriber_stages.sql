-- Lets a subscriber pick internship alerts, entry-level alerts, or both,
-- instead of always getting alerted for whichever category/location they
-- picked regardless of stage (see src/build-view.ts's new stage-picker
-- checkboxes, 2026-09-14).
--
-- Defaults to both stages so this is safe to add without breaking every
-- existing subscriber's alerts: the DEFAULT fills in ['internship',
-- 'entry-level'] for every row already in the table (same behavior they had
-- before this column existed), so no VALIDATE/NOT VALID dance is needed the
-- way location's migrations needed - every existing row satisfies the CHECK
-- the moment the column is added, not just going forward.
alter table subscribers add column if not exists stages text[] not null default array['internship', 'entry-level']::text[];

alter table subscribers drop constraint if exists subscribers_stages_check;
alter table subscribers add constraint subscribers_stages_check check (
  array_length(stages, 1) >= 1 and stages <@ array['internship', 'entry-level']::text[]
);
