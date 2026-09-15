// Same pipeline as run.ts, but backed by Supabase instead of the local
// data/companies.json-adjacent data/seen.json file. Requires .env to be set
// up with SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (see .env.example and
// README's Supabase setup section).
//
// data/companies.json is still the editable source of truth for which
// companies to track - this just also persists postings centrally instead
// of in a local file, which is what makes this runnable on a schedule from
// a server later instead of only from your own machine.

import { readFile } from "node:fs/promises";
import type { Company, RawPosting, TaggedPosting } from "./types.js";
import { fetchGreenhouse } from "./scrapers/greenhouse.js";
import { fetchLever } from "./scrapers/lever.js";
import { fetchAshby } from "./scrapers/ashby.js";
import { fetchWorkday } from "./scrapers/workday.js";
import { fetchSmartRecruiters } from "./scrapers/smartrecruiters.js";
import { classify } from "./classify.js";
import { categorize } from "./categorize.js";
import { isUSLocation } from "./location.js";
import { getSupabase, syncCompanies, insertBatch } from "./db.js";
import { closeBrowser } from "./browser.js";
import { sendAlerts } from "./send-alerts.js";
import { sendConfirmations } from "./send-confirmations.js";
import { classifyPostingWithLLM } from "./llm-categorize.js";

// Real-data catch (2026-09-14): the free team/title/company/major regex
// signals in categorize.ts still leave a meaningful chunk of postings in
// "other" (see llm-categorize-other.ts's backfill results). Rather than
// letting "other" quietly build back up between manual backfill runs, every
// NEWLY inserted posting that's alertable (internship or entry-level) and
// landed in "other" gets one LLM read right here, same prompt/logic as the
// backfill script (see llm-categorize.ts). This only ever touches genuinely
// new postings, not the whole table, so the ongoing cost is proportional to
// new-posting volume, not table size - see the chat for the breakdown
// (a few dollars a month at most). Skipped entirely (logged once, not an
// error) if ANTHROPIC_API_KEY isn't set, same pattern as send-alerts.ts's
// RESEND_API_KEY check - the rest of the pipeline still works fine without
// it, postings just stay in "other" until a manual backfill run.
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const COMPANIES_PATH = new URL("../data/companies.json", import.meta.url);

async function loadCompanies(): Promise<Company[]> {
  const raw = await readFile(COMPANIES_PATH, "utf-8");
  return JSON.parse(raw);
}

async function fetchCompany(company: Company): Promise<RawPosting[]> {
  switch (company.ats) {
    case "greenhouse":
      return fetchGreenhouse(company);
    case "lever":
      return fetchLever(company);
    case "ashby":
      return fetchAshby(company);
    case "workday":
      return fetchWorkday(company);
    case "smartrecruiters":
      return fetchSmartRecruiters(company);
  }
}

// How many companies to fetch at once. Was previously 1 (a plain for-loop,
// fully sequential) - at 1,343 companies and growing, that meant the whole
// run's wall time was the SUM of every company's network round-trip, one
// after another, even though each company's fetch is completely
// independent of every other's. A run that took 20+ minutes wasn't CPU- or
// hardware-bound at all (the machine is idle, waiting on other companies'
// servers the entire time) - it was purely this for-loop refusing to start
// company #2 until company #1's request came all the way back. Moving this
// to a faster/paid server wouldn't fix that; overlapping the network
// round-trips does. Same fix, same reasoning, as UPDATE_CONCURRENCY in
// reclassify.ts. Picked conservatively (not as high as reclassify's 20)
// because several companies can share a host (boards-api.greenhouse.io
// serves every Greenhouse company), where too much concurrency against one
// host risks tripping that host's own rate limiting rather than helping.
const COMPANY_CONCURRENCY = 10;

// Only touches postings that (a) are actually alertable - no point spending
// an LLM call on a posting nobody will ever see filtered by category, and
// (b) are still exactly ["other"] after the free signals ran. Mutates
// posting.categories/categoryReason in place (rather than just writing to
// the DB) so the console log below and sendAlerts()'s category matching at
// the end of this run both see the corrected category immediately, instead
// of a subscriber missing this run's alert because the DB write landed a
// moment too late for in-memory matching to see it.
async function maybeUpgradeOtherWithLLM(supabase: ReturnType<typeof getSupabase>, posting: TaggedPosting): Promise<void> {
  if (!ANTHROPIC_API_KEY) return;
  if (!(posting.isInternship || posting.isEntryLevel)) return;
  if (!(posting.categories.length === 1 && posting.categories[0] === "other")) return;

  let result;
  try {
    result = await classifyPostingWithLLM(
      { title: posting.title, team: posting.team, companyName: posting.company, descriptionText: posting.descriptionText },
      ANTHROPIC_API_KEY
    );
  } catch (err) {
    console.error(`  [llm] categorize failed for "${posting.title}" (${posting.company}): ${(err as Error).message}`);
    return;
  }
  if (!result) return;

  const isStillOther = result.categories.length === 1 && result.categories[0] === "other";
  if (isStillOther) return; // nothing to change - already "other" in the DB from insertBatch

  posting.categories = result.categories;
  posting.categoryReason = `${posting.categoryReason}${posting.categoryReason ? "; " : ""}llm: ${result.reason}`.trim();

  const { error } = await supabase
    .from("postings")
    .update({ categories: posting.categories, category_reason: posting.categoryReason })
    .eq("ats", posting.ats)
    .eq("external_id", posting.externalId);
  if (error) {
    console.error(`  [llm] db update failed for "${posting.title}": ${error.message}`);
  }
}

interface CompanyResult {
  newInternshipCount: number;
  newEntryLevelCount: number;
  newTotalCount: number;
  droppedNonUSCount: number;
  // Just the internship/entry-level subset of what got inserted this
  // run (not every inserted row - insertBatch stores every US posting
  // regardless of stage, same as what the listing itself shows/hides) -
  // this is what alert matching runs against at the end of main().
  newAlertablePostings: TaggedPosting[];
}

async function processCompany(
  company: Company,
  supabase: ReturnType<typeof getSupabase>,
  companyIdByKey: Map<string, string>
): Promise<CompanyResult> {
  const result: CompanyResult = { newInternshipCount: 0, newEntryLevelCount: 0, newTotalCount: 0, droppedNonUSCount: 0, newAlertablePostings: [] };

  let postings: RawPosting[];
  try {
    postings = await fetchCompany(company);
  } catch (err) {
    console.error(`  [${company.name}] fetch error:`, (err as Error).message);
    return result;
  }

  // US-only for now - GTM is US college students, and non-US postings
  // just add noise to the feed. Blocklist approach (see location.ts):
  // ambiguous/missing location strings are kept rather than dropped.
  const usPostings = postings.filter((p) => isUSLocation(p.location));
  result.droppedNonUSCount = postings.length - usPostings.length;

  const companyId = companyIdByKey.get(`${company.ats}:${company.slug}`);
  const tagged = usPostings.map((posting) => categorize(classify(posting)));

  // One request for this company's whole batch instead of one per
  // posting - the thing that made large companies (Nike: 261 postings)
  // take minutes of silent one-by-one network round-trips.
  //
  // This Supabase write needs the same try/catch treatment as the scraper
  // fetch above: this runs unattended every 30 min via launchd, and a
  // single transient network blip here (wifi dropping overnight, a
  // momentary Supabase hiccup) used to throw uncaught, killing the whole
  // run and leaving every company after it unchecked for that cycle -
  // real damage on a large registry (1,343 companies means hundreds
  // skipped by one bad network call partway through). Log and move on.
  let inserted: typeof tagged = [];
  try {
    inserted = await insertBatch(supabase, tagged, companyId);
  } catch (err) {
    console.error(`  [${company.name}] insert error:`, (err as Error).message);
    return result;
  }
  result.newTotalCount = inserted.length;

  for (const posting of inserted) {
    // Before logging/queuing for alerts - see maybeUpgradeOtherWithLLM's
    // comment for why this has to happen first, not after.
    await maybeUpgradeOtherWithLLM(supabase, posting);

    if (posting.isInternship) {
      result.newInternshipCount++;
      result.newAlertablePostings.push(posting);
      console.log(
        `  NEW INTERNSHIP  [${posting.categories.join(",")}/${posting.classifierReason}]  ${posting.company} — ${posting.title}\n    ${posting.url}`
      );
    } else if (posting.isEntryLevel) {
      result.newEntryLevelCount++;
      result.newAlertablePostings.push(posting);
      console.log(
        `  NEW ENTRY-LEVEL [${posting.categories.join(",")}/${posting.entryLevelReason}]  ${posting.company} — ${posting.title}\n    ${posting.url}`
      );
    }
  }

  return result;
}

// Bounded-concurrency worker pool, same shape as discover.ts's
// runWithConcurrency - a fixed number of workers each pull the next
// not-yet-started company off the shared index until the list is exhausted,
// so at most COMPANY_CONCURRENCY companies are ever in flight at once.
async function runCompaniesWithConcurrency(companies: Company[], concurrency: number, fn: (c: Company, i: number) => Promise<void>) {
  let i = 0;
  async function worker() {
    while (i < companies.length) {
      const idx = i++;
      await fn(companies[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
}

async function main() {
  const supabase = getSupabase();
  const companies = await loadCompanies();

  console.log(`Syncing ${companies.length} companies to Supabase...`);
  const companyIdByKey = await syncCompanies(supabase, companies);

  if (!ANTHROPIC_API_KEY) {
    console.log("  [llm] ANTHROPIC_API_KEY not set - new postings landing in \"other\" won't get an LLM re-read this run.");
  }

  let newInternshipCount = 0;
  let newEntryLevelCount = 0;
  let newTotalCount = 0;
  let droppedNonUSCount = 0;
  let completed = 0;
  const newAlertablePostings: TaggedPosting[] = [];

  await runCompaniesWithConcurrency(companies, COMPANY_CONCURRENCY, async (company) => {
    const result = await processCompany(company, supabase, companyIdByKey);
    completed++;
    console.log(`[${completed}/${companies.length}] ${company.name} done`);

    newInternshipCount += result.newInternshipCount;
    newEntryLevelCount += result.newEntryLevelCount;
    newTotalCount += result.newTotalCount;
    droppedNonUSCount += result.droppedNonUSCount;
    newAlertablePostings.push(...result.newAlertablePostings);
  });

  console.log(
    `\nDone. ${newInternshipCount} new internship, ${newEntryLevelCount} new entry-level posting(s) (${newTotalCount} new postings total, ${droppedNonUSCount} non-US postings skipped) this run.`
  );

  // Same defensive treatment as the scraper/insert calls above - alert
  // sending is a nice-to-have on top of an otherwise-successful run, not
  // something that should make the whole run look like it failed.
  await sendAlerts(supabase, newAlertablePostings).catch((err) => {
    console.error("Alert sending error:", (err as Error).message);
  });

  // Unlike sendAlerts, this doesn't depend on newAlertablePostings - new
  // signups need confirming regardless of whether this run found any new
  // postings at all.
  await sendConfirmations(supabase).catch((err) => {
    console.error("Confirmation sending error:", (err as Error).message);
  });
}

main()
  .catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  })
  .finally(() => {
    // No-op if the Workday 429 fallback never actually launched a browser
    // this run (see browser.ts) - but if it did, close it so the process
    // exits cleanly instead of hanging on an open Chromium handle. Runs
    // unattended via launchd every 30 min, so a run that never exits would
    // quietly pile up stuck processes over time. Swallow errors here - a
    // failed cleanup shouldn't turn an otherwise-successful run into a
    // reported failure.
    return closeBrowser().catch((err) => {
      console.error("Browser cleanup error:", (err as Error).message);
    });
  });
