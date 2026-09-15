import type { Company, RawPosting } from "../types.js";
import { fetchWithTimeout } from "../fetchWithTimeout.js";
import { fetchWorkdayViaBrowser } from "./workday-browser.js";
import {
  parseWorkdayUrl,
  parseWorkdayPostedOn,
  cxsUrl,
  careersBaseUrl,
  postingsFromJobs,
  type WorkdayJob,
} from "./workday-shared.js";

// Workday has no guessable slug like Greenhouse/Lever/Ashby. Each tenant's
// careers site is a URL like:
//   https://nike.wd1.myworkdayjobs.com/en-US/nike_careers
// and underneath it is a JSON API most tenants expose without needing a
// browser:
//   POST https://nike.wd1.myworkdayjobs.com/wday/cxs/nike/nike_careers/jobs
//
// parseWorkdayUrl() (now in workday-shared.ts, re-exported here so existing
// callers like add-workday.ts don't need to change their import) turns a
// real careers URL (found by visiting the company's site - see
// src/add-workday.ts) into the {tenant, wdHost, site} triple needed to call
// that API.
export { parseWorkdayUrl, parseWorkdayPostedOn };

const PAGE_LIMIT = 20;

export async function fetchWorkday(company: Company): Promise<RawPosting[]> {
  if (!company.workday) {
    throw new Error(`${company.name} is marked ats: "workday" but has no workday{tenant,wdHost,site} set`);
  }
  const endpoint = cxsUrl(company.workday);
  const baseUrl = careersBaseUrl(company.workday);

  const postings: RawPosting[] = [];
  let offset = 0;
  let total = Infinity;

  while (offset < total) {
    const res = await fetchWithTimeout(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appliedFacets: {}, limit: PAGE_LIMIT, offset, searchText: "" }),
    });

    // Real-data catch (2026-09-13): a growing list of large Workday
    // tenants (Cisco, RTX, Northrop Grumman, DaVita, Thermo Fisher, and
    // more) now hard-reject this plain POST with a 429 on every single
    // run, not just occasionally - that's bot protection (Akamai or
    // similar) fingerprinting non-browser traffic, and no amount of
    // retrying a bare fetch() gets past it. Falling back to a real
    // (headless) browser session - see workday-browser.ts - is the only
    // thing that actually works for these tenants. Any offset already
    // fetched this call is thrown away and the whole company is re-fetched
    // via the browser path from scratch, since a company that gets
    // blocked mid-pagination is presumably going to keep getting blocked
    // for the rest of its pages too.
    //
    // Real-data catch (2026-09-14): Redfin's tenant returns 403 for the
    // exact same plain-POST-gets-blocked reason, not 429 - different
    // tenants' bot protection apparently reports it differently (rate-limit
    // framing vs. flat access-denied framing), but the underlying problem
    // and the fix are identical, so both statuses route to the same
    // fallback rather than only handling the one status seen first.
    if (res.status === 429 || res.status === 403) {
      console.warn(`  [${company.name}] Workday returned ${res.status} (bot-protected tenant) - retrying with a browser session`);
      return fetchWorkdayViaBrowser(company);
    }

    if (!res.ok) {
      throw new Error(`Workday fetch failed for ${company.name} (${res.status})`);
    }

    const data = (await res.json()) as { total: number; jobPostings: WorkdayJob[] };
    total = data.total;
    postings.push(...postingsFromJobs(company, baseUrl, data.jobPostings));

    offset += PAGE_LIMIT;
  }

  return postings;
}
