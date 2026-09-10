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

## Next steps

1. Run against the 4 seed companies in `data/companies.json`, sanity-check
   the output, then grow the registry to a few hundred real companies.
2. Watch `classifierReason: "no-signal"` misses and negative-title false
   positives for a bit — that's where the rules need tuning before we trust
   this for a live registry.
3. Swap the JSON file registry + `seen.json` for Supabase tables.
4. Add a scheduler and wire up alert delivery.
