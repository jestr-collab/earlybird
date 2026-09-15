// Bulk company discovery from a second, non-CS-focused source: a public
// registry.csv (company, platform, token) maintained by a community
// finance/professional-services internship tracker. This is the same idea
// as discover-trackers.ts (mine a community-maintained public source, live-
// check every candidate, write hits to discovered.json for review) but a
// different shape of source - a flat CSV instead of a markdown README table
// - which is why it's a separate script rather than another entry in
// discover-trackers.ts's TRACKER_SOURCES: that file's parsing is built
// around extracting (ats, slug) out of an application URL, and this source
// hands us the (platform, token) pair directly, pre-extracted, no URL or
// markdown parsing needed at all.
//
// Why this source: it's skewed toward exactly the fields our own coverage
// is thin on right now (banks, asset managers, PE/HF, consulting), unlike
// the SimplifyJobs/vanshb03 sources discover-trackers.ts already covers
// (both CS/SWE-focused). Real-data catch (2026-09-14): a first look at
// competing non-CS tracker repos (jobright-ai's field-specific repos,
// summer2026internships/Summer2026-Internships) found their application
// links point at LinkedIn Jobs or their own aggregator redirect pages, not
// a direct ATS - unusable for automated discovery. This CSV is the
// exception: it names the real ATS platform per company directly.
//
// Like discover-trackers.ts and discover.ts, this deliberately does NOT
// auto-merge into companies.json - it writes hits to discovered.json for a
// human to skim and run merge-discovered.ts on.

import { readFile, writeFile } from "node:fs/promises";
import type { AtsType, Company } from "./types.js";

const REGISTRY_URL = "https://raw.githubusercontent.com/Levaix/New-Internship-Tracker/main/tracker/registry.csv";

const COMPANIES_PATH = new URL("../data/companies.json", import.meta.url);
const DISCOVERED_PATH = new URL("../data/discovered.json", import.meta.url);

// The registry also lists companies on ATSs this pipeline doesn't support
// yet (pinpoint, workable, talnet/tal.net, oracle, breezy, eightfold,
// avature) - those platforms just get silently skipped below, same as an
// unrecognized URL host in discover-trackers.ts's classifyUrl().
const SUPPORTED_PLATFORMS = new Set<string>(["greenhouse", "lever", "ashby", "smartrecruiters", "workday"]);

interface Hit {
  name: string;
  ats: AtsType;
  slug: string;
  workday?: NonNullable<Company["workday"]>;
}

// Splits one CSV data row into its 3 fields. Real-data catch: confirmed
// against the actual downloaded file that no company name or token contains
// a comma and nothing is quote-wrapped, so a plain split is safe here - a
// general CSV parser would be overkill (and this'd need revisiting if the
// source file's formatting ever changes).
function parseCsvLine(line: string): string[] {
  return line.split(",");
}

// Workday rows encode all three pieces parseWorkdayUrl() would normally
// extract from a real careers URL, just pre-parsed into the token field as
// "<tenant>.<wdHost>.myworkdayjobs.com|<tenant>|<site>", e.g.
// "markelcorp.wd5.myworkdayjobs.com|markelcorp|GlobalCareers". Pulling
// wdHost back out of the domain (rather than trusting a second copy of it
// elsewhere - there isn't one) mirrors what parseWorkdayUrl does when given
// a real URL.
function parseWorkdayToken(token: string): NonNullable<Company["workday"]> | null {
  const parts = token.split("|");
  if (parts.length !== 3) return null;
  const [domain, tenant, site] = parts;
  const m = domain.match(/\.([a-z0-9]+)\.myworkdayjobs\.com$/i);
  if (!m || !tenant || !site) return null;
  return { tenant, wdHost: m[1], site };
}

function parseRegistry(csv: string): Array<{ name: string; ats: AtsType; slug: string; workday?: NonNullable<Company["workday"]> }> {
  const lines = csv.split("\n").map((l) => l.trim()).filter(Boolean);
  const [header, ...rows] = lines;
  if (!header || !header.toLowerCase().startsWith("company,platform,token")) {
    throw new Error(`Unexpected registry.csv header: "${header}" - source format may have changed`);
  }

  const out: Array<{ name: string; ats: AtsType; slug: string; workday?: NonNullable<Company["workday"]> }> = [];
  for (const line of rows) {
    const [name, platform, token] = parseCsvLine(line);
    if (!name || !platform || !token) continue;
    if (!SUPPORTED_PLATFORMS.has(platform)) continue;

    if (platform === "workday") {
      const workday = parseWorkdayToken(token);
      if (!workday) continue; // malformed token - skip rather than guess
      out.push({ name, ats: "workday", slug: workday.tenant, workday });
    } else {
      out.push({ name, ats: platform as AtsType, slug: token });
    }
  }
  return out;
}

// Same liveness check as discover-trackers.ts - confirms a candidate still
// returns real job data right now, not just that it was in the CSV.
async function isLive(hit: Hit): Promise<boolean> {
  try {
    switch (hit.ats) {
      case "greenhouse": {
        const res = await fetch(`https://boards-api.greenhouse.io/v1/boards/${hit.slug}/jobs`);
        if (!res.ok) return false;
        const data = (await res.json()) as { jobs?: unknown[] };
        return (data.jobs?.length ?? 0) > 0;
      }
      case "lever": {
        const res = await fetch(`https://api.lever.co/v0/postings/${hit.slug}?mode=json`);
        if (!res.ok) return false;
        const data = await res.json();
        return Array.isArray(data) && data.length > 0;
      }
      case "ashby": {
        const res = await fetch(`https://api.ashbyhq.com/posting-api/job-board/${hit.slug}`);
        if (!res.ok) return false;
        const data = (await res.json()) as { jobs?: unknown[] };
        return (data.jobs?.length ?? 0) > 0;
      }
      case "smartrecruiters": {
        const res = await fetch(`https://api.smartrecruiters.com/v1/companies/${hit.slug}/postings?limit=1`);
        if (!res.ok) return false;
        const data = (await res.json()) as { totalFound?: number };
        return (data.totalFound ?? 0) > 0;
      }
      case "workday": {
        if (!hit.workday) return false;
        const { tenant, wdHost, site } = hit.workday;
        const res = await fetch(`https://${tenant}.${wdHost}.myworkdayjobs.com/wday/cxs/${tenant}/${site}/jobs`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ appliedFacets: {}, limit: 1, offset: 0, searchText: "" }),
        });
        // A 429/403 here (bot-protected tenant, same as workday.ts's live
        // pipeline hits) is treated as not-live rather than routed through
        // the browser fallback - this script only wants candidates cheap
        // and safe to auto-merge, not every technically-real tenant.
        if (!res.ok) return false;
        const data = (await res.json()) as { total?: number };
        return (data.total ?? 0) > 0;
      }
    }
  } catch {
    return false;
  }
}

async function runWithConcurrency<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

async function main() {
  const companiesRaw = await readFile(COMPANIES_PATH, "utf-8");
  const companies: Company[] = JSON.parse(companiesRaw);
  const existingKeys = new Set(companies.map((c) => `${c.ats}:${c.slug}`.toLowerCase()));

  console.log(`Fetching ${REGISTRY_URL} ...`);
  const res = await fetch(REGISTRY_URL);
  if (!res.ok) throw new Error(`Failed to fetch registry.csv: ${res.status}`);
  const csv = await res.text();

  const rows = parseRegistry(csv);
  console.log(`${rows.length} row(s) on a supported platform (of the full registry)`);

  const seen = new Set<string>();
  const toCheck: Hit[] = [];
  for (const row of rows) {
    const key = `${row.ats}:${row.slug}`.toLowerCase();
    if (existingKeys.has(key) || seen.has(key)) continue;
    seen.add(key);
    toCheck.push(row);
  }

  console.log(`${toCheck.length} new candidate(s) to live-check...`);
  const liveFlags = await runWithConcurrency(toCheck, 8, isLive);
  const found: Company[] = toCheck
    .filter((_, i) => liveFlags[i])
    .map((h) => ({ slug: h.slug, name: h.name, ats: h.ats, ...(h.workday ? { workday: h.workday } : {}) }));

  await writeFile(DISCOVERED_PATH, JSON.stringify(found, null, 2));
  console.log(`\nDone. ${found.length} live hit(s) out of ${toCheck.length} candidate(s) checked.`);
  console.log(`Written to data/discovered.json - review, then npm run merge-discovered.`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
