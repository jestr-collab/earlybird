# earlybird

Surfaces internship postings from company career pages within hours of posting,
before they syndicate to LinkedIn/Indeed.

## Phase 1 (this scaffold)

A standalone pipeline that proves the core loop works, with no DB, auth, or
frontend yet:

1. `data/companies.json` — the company registry (which companies to track, and
   which ATS each one runs on).
2. `src/scrapers/{greenhouse,lever,ashby}.ts` — one fetcher per ATS, each
   normalized into the shared `RawPosting` shape in `src/types.ts`.
3. `src/classify.ts` — rules-based internship/not classifier. Every decision
   logs which signal fired (`classifierReason`) so we can see what's wrong
   once real data flows through, before reaching for an LLM fallback.
4. `src/run.ts` — fetches every company, dedupes against `data/seen.json`
   (gitignored — this is our own "first seen" ground truth, since not every
   ATS reports a trustworthy posted date), classifies anything new, and
   prints internships found.

## Setup

```bash
npm install
npm run fetch
```

Run it again later — it'll only report postings it hasn't seen before.

## What's deliberately not here yet

- Workday and custom in-house career pages (need Playwright; higher
  maintenance, phase 2).
- A real job queue / scheduler (this is a manual `npm run fetch` for now —
  cron or Trigger.dev/Inngest comes once the fetch logic is trustworthy).
- DB (Supabase), auth, email alerts (Resend), payments (Stripe), frontend.
- LLM-based classification fallback for postings the rules can't decide on.

## Growing the company registry

**One at a time**, when you already have a company in mind:

```
npm run find-slug -- affirm doordash figma
```

Guess a company's slug (usually its name, lowercased, no spaces) and this
checks it against all three ATS APIs at once and tells you which one (if
any) is real, and how many jobs are live. Add hits to `data/companies.json`.

**In bulk**, using the free public [YC company directory](https://github.com/yc-oss/api)
(6,000+ companies, no auth needed) as a source of names to check:

```
npm run discover -- --limit 300
```

Fetches the YC company list, guesses a couple of slug variants per company,
checks each against all three ATS APIs (6 requests in flight at a time by
default — bump with `--concurrency`), and writes hits to
`data/discovered.json`. Review that file and merge what you want into
`data/companies.json` — it's not auto-merged, since a short company name can
occasionally collide with an unrelated company using the same slug.

Either way: if a company doesn't show up on any of the three, it's likely
Workday or a custom board — not supported yet (phase 2).

## Supabase setup (phase 2 — real persistence)

`npm run fetch` (local JSON) still works and isn't going away — `fetch:db`
is a parallel, Supabase-backed version of the same pipeline for when you're
ready to move off your own machine being the only place this data lives.

1. Create a free project at [supabase.com](https://supabase.com) (new org if
   you don't have one, then "New project" — pick any region, set a DB
   password you'll never need to remember since we use the API key instead).
2. Once it's provisioned: **Project Settings -> API**. Copy the **Project
   URL** and the **`service_role` secret** (not the `anon`/public key — this
   script needs to bypass row-level security since it's a trusted backend
   job, not a browser client).
3. `cp .env.example .env` and paste those two values in.
4. **SQL Editor -> New query**, paste in the contents of `supabase/schema.sql`,
   click Run. Creates two tables: `companies` and `postings` (see the file
   for the schema — `postings` has a unique constraint on `(ats,
   external_id)`, which is what replaces `data/seen.json`'s job).
5. `npm install` (picks up the new `@supabase/supabase-js` dependency).
6. `npm run fetch:db` — same output as `npm run fetch`, but now every
   posting is written to Supabase instead of a local file. You can browse
   the `postings` table directly in the Supabase dashboard (Table Editor) to
   see it.

`data/companies.json` stays the editable source of truth for which
companies to track either way — `fetch:db` just also upserts it into the
`companies` table on every run, so postings can reference a real
`company_id`.

## Workday (banks, consulting, F500)

Greenhouse/Lever/Ashby skew heavily toward tech/startup employers. Most
traditional big employers — banks, consulting firms, most Fortune 500 —
run Workday instead, which has no guessable slug the way the other three
do. Adding one means finding its real careers URL yourself:

1. Visit the company's "careers" link. If they're on Workday, you'll land
   on (or get redirected to) something like
   `https://nike.wd1.myworkdayjobs.com/en-US/nike_careers`. If it doesn't
   look like that, they're not on Workday (SuccessFactors, iCIMS, a fully
   custom portal — none of those are supported here yet).
2. `npm run add-workday -- <that full url> "Company Name"` — parses out
   the tenant/site, tests the underlying API directly, and prints a
   ready-to-paste `data/companies.json` entry if it works.
3. If it fails with a non-200 status, that tenant likely sits behind bot
   protection and needs a real browser session (Playwright) instead of a
   plain request — not supported yet, worth flagging back rather than
   spending time on.

Worth trying, since these are the employers your actual target audience
(college finance/business students) searches for most: Goldman Sachs,
Morgan Stanley, JPMorgan Chase, Bank of America, Wells Fargo, Citi,
Deloitte, PwC, EY, KPMG, Accenture, McKinsey, BCG, Bain, Capital One,
American Express, Visa, Mastercard, Target, Nike, Nordstrom, Boeing,
Lockheed Martin.

If you already applied the original `schema.sql` in Supabase, run
`supabase/migrations/001_add_workday.sql` too — the `ats` column has a
check constraint that needs updating to allow `"workday"` as a value.

## Scheduler

Set up on your Mac directly (not through Claude) with `launchd`, since that
survives independent of any bridge/session — see the setup Claude walked you
through for the exact plist. Once installed, `npm run fetch` runs
automatically at the configured interval, appending output to a log file, so
"posted within 24 hours" starts being something we actually measure instead
of assume.

## Next steps

1. Grow the registry further — keep pushing Greenhouse/Lever/Ashby with
   `npm run discover`, and work through the Workday candidate list above
   with `npm run add-workday`.
2. Once `fetch:db` has a few days of real scheduled runs behind it, add the
   simplest possible alert delivery (a Resend email digest of new
   internships) so this stops being something only visible in a terminal.
3. Landing page + signup, so there's somewhere to point people before GTM
   outreach starts.
4. Auth + Stripe once there's a reason to gate access.
