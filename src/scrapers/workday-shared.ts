// Bits shared between the two ways of talking to a Workday tenant's job
// API: a plain POST (workday.ts, fast, works for most tenants) and a real
// headless-browser session (workday-browser.ts, slower, only used as a
// fallback for tenants that block the plain POST - see workday.ts's
// real-data catch on the 429 fallback). Split out into its own file so
// those two don't import each other (workday.ts calls into
// workday-browser.ts on a 429, so workday-browser.ts importing back from
// workday.ts would be a circular import).

import type { Company, RawPosting } from "../types.js";

const LOCALE_SEGMENT = /^[a-z]{2}(-[A-Z]{2})?$/; // e.g. "en-US", "en"

export function parseWorkdayUrl(url: string): { tenant: string; wdHost: string; site: string } {
  const u = new URL(url);
  const hostParts = u.hostname.split(".");
  // expects: {tenant}.{wdHost}.myworkdayjobs.com
  const myworkdayjobsIdx = hostParts.indexOf("myworkdayjobs");
  if (myworkdayjobsIdx < 2) {
    throw new Error(`Doesn't look like a myworkdayjobs.com URL: ${url}`);
  }
  const tenant = hostParts[myworkdayjobsIdx - 2];
  const wdHost = hostParts[myworkdayjobsIdx - 1];

  const pathParts = u.pathname.split("/").filter(Boolean);
  const site = pathParts.find((p) => !LOCALE_SEGMENT.test(p));
  if (!site) {
    throw new Error(`Couldn't find a site name in the URL path: ${url}`);
  }

  return { tenant, wdHost, site };
}

export function cxsUrl(company: NonNullable<Company["workday"]>): string {
  return `https://${company.tenant}.${company.wdHost}.myworkdayjobs.com/wday/cxs/${company.tenant}/${company.site}/jobs`;
}

export function careersBaseUrl(company: NonNullable<Company["workday"]>): string {
  return `https://${company.tenant}.${company.wdHost}.myworkdayjobs.com/${company.site}`;
}

export interface WorkdayJob {
  title: string;
  externalPath: string; // e.g. "/job/San-Francisco-CA/Software-Engineering-Intern_JR12345"
  postedOn?: string;     // relative bucket text: "Posted Today", "Posted 3 Days Ago", etc.
  locationsText?: string;
  bulletFields?: string[];
}

// Workday only gives a relative bucket ("Posted Today", "Posted 3 Days
// Ago", "Posted 30+ Days Ago"), not an exact timestamp - so this is
// necessarily an approximation, not a real posted-at time. But it's a much
// better approximation than having no atsUpdatedAt at all: without this,
// every posting from a newly-added Workday company gets stamped with
// first_seen_at = right now (the moment the company was onboarded), which
// makes a job that's actually been live for weeks look brand new on first
// sync. This turns that into "posted about N days ago" instead of "just
// now" - approximate but honest, versus precise but wrong.
export function parseWorkdayPostedOn(postedOn: string | undefined, now: Date = new Date()): string | undefined {
  if (!postedOn) return undefined;
  const text = postedOn.toLowerCase();

  if (text.includes("today")) return now.toISOString();
  if (text.includes("yesterday")) return daysAgo(now, 1);

  // "Posted N Days Ago" / "Posted N+ Days Ago" - the "+" variant (usually
  // "30+") means "at least N", so this slightly understates age in that
  // case, but that's still far closer to the truth than "just now".
  const match = text.match(/(\d+)\+?\s*days?\s*ago/);
  if (match) return daysAgo(now, Number(match[1]));

  return undefined; // unrecognized format - don't guess, fall back to first_seen_at
}

function daysAgo(now: Date, days: number): string {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

// Turns one page of Workday's raw jobPostings response into RawPosting[],
// applying the same missing-externalPath guard regardless of which fetch
// path (plain POST or browser) produced the page.
//
// Real-data catch (2026-09-13): TJX and Loblaw Companies both returned at
// least one jobPosting with no externalPath, despite the type above
// declaring it required - that's just an unchecked cast, not a runtime
// guarantee. A missing externalId isn't just a bad URL (baseUrl +
// "undefined"), it violates postings.external_id's NOT NULL constraint,
// which used to take down the *entire* company's insert for that run (see
// db.ts's insertBatch fix for the other half of this). Skip and log rather
// than pushing a posting that can never be stored.
export function postingsFromJobs(company: Company, baseUrl: string, jobPostings: WorkdayJob[]): RawPosting[] {
  const postings: RawPosting[] = [];
  for (const job of jobPostings) {
    if (!job.externalPath) {
      console.warn(`  [${company.name}] Workday job missing externalPath, skipping: ${job.title ?? "(no title)"}`);
      continue;
    }
    postings.push({
      externalId: job.externalPath,
      company: company.name,
      ats: "workday",
      title: job.title,
      location: job.locationsText,
      atsUpdatedAt: parseWorkdayPostedOn(job.postedOn),
      url: `${baseUrl}${job.externalPath}`,
    });
  }
  return postings;
}
