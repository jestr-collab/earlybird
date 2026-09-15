// Fallback for Workday tenants that reject workday.ts's plain POST with a
// 429. Real-data catch (2026-09-13): a growing set of large, well-known
// companies (Cisco, RTX, Northrop Grumman, DaVita, Thermo Fisher, and ~15
// others as of this writing, seen failing on every run for at least two
// runs in a row - not an occasional timeout) sit behind bot protection
// (Akamai or similar) that fingerprints the plain POST as non-browser
// traffic and blocks it outright, regardless of retries. A bare Node
// fetch() can never pass that check, however many times it's retried - it
// has no browser TLS/JS fingerprint and runs no challenge script.
//
// The fix is to make the same request from inside a real (headless)
// browser instead: load the tenant's own careers page first (so any
// bot-detection challenge script actually runs and sets whatever cookies
// it wants), then issue the same jobs API POST using the *page's own*
// fetch - same cookies, same TLS stack, same JS engine a real visitor's
// browser would have. This is slower and heavier than the plain path (a
// real Chromium page load per company instead of one HTTP request), which
// is exactly why it's only used as a fallback for tenants that need it,
// not the default path for everyone.
import type { Company, RawPosting } from "../types.js";
import { getBrowser } from "../browser.js";
import { careersBaseUrl, cxsUrl, postingsFromJobs, type WorkdayJob } from "./workday-shared.js";

const PAGE_LOAD_TIMEOUT_MS = 30_000;
const PAGE_FETCH_LIMIT = 20;

export async function fetchWorkdayViaBrowser(company: Company): Promise<RawPosting[]> {
  if (!company.workday) {
    throw new Error(`${company.name} is marked ats: "workday" but has no workday{tenant,wdHost,site} set`);
  }
  const baseUrl = careersBaseUrl(company.workday);
  const endpoint = cxsUrl(company.workday);

  const browser = await getBrowser();
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    // Loading the real careers page first is the whole point - it's what
    // gives the tenant's bot-protection script a chance to run and set
    // whatever cookies it's going to demand before the jobs API call
    // happens. "domcontentloaded" rather than the slower "load"/
    // "networkidle" - the challenge script runs early, and some of these
    // career pages keep long-polling in the background forever, which
    // would make "networkidle" a needless multi-second wait every time.
    await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: PAGE_LOAD_TIMEOUT_MS });

    const postings: RawPosting[] = [];
    let offset = 0;
    let total = Infinity;

    while (offset < total) {
      // Runs fetch() *inside* the page, not from Node - same cookies, TLS
      // fingerprint, and JS engine a real visitor's browser would present,
      // which is the entire reason this path exists.
      const data = await page.evaluate(
        async ({ endpoint, limit, offset }) => {
          const res = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ appliedFacets: {}, limit, offset, searchText: "" }),
          });
          if (!res.ok) throw new Error(`status ${res.status}`);
          return (await res.json()) as { total: number; jobPostings: WorkdayJob[] };
        },
        { endpoint, limit: PAGE_FETCH_LIMIT, offset }
      );

      total = data.total;
      postings.push(...postingsFromJobs(company, baseUrl, data.jobPostings));
      offset += PAGE_FETCH_LIMIT;
    }

    console.log(`  [${company.name}] Workday browser fallback succeeded (${postings.length} posting(s))`);
    return postings;
  } finally {
    // Close this company's page/context, but leave the shared browser
    // itself running for the next company that needs the fallback.
    await context.close();
  }
}
