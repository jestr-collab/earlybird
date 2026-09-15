// Bulk company discovery: pulls the free, public YC company directory
// (https://github.com/yc-oss/api — 6,000+ YC-funded companies, updated
// daily, no auth needed) and checks each one against Greenhouse, Lever,
// and Ashby's public APIs to find real, working (slug, ats) pairs.
//
// Usage:
//   npm run discover -- --limit 300
//   npm run discover -- --limit 500 --concurrency 8
//
// Writes hits to data/discovered.json. Review that file and merge what you
// want into data/companies.json — this deliberately does NOT auto-merge,
// since YC-derived slug guesses can occasionally collide with an unrelated
// company that happens to use the same short name.

import { writeFile } from "node:fs/promises";
import type { AtsType, Company } from "./types.js";

const YC_COMPANIES_URL = "https://yc-oss.github.io/api/companies/all.json";
const DISCOVERED_PATH = new URL("../data/discovered.json", import.meta.url);

interface YcCompany {
  name: string;
  slug: string;
  website: string;
  status: string; // "Active" | "Acquired" | "Public" | "Dead" | ...
}

const CHECKS: Array<{ ats: AtsType; url: (slug: string) => string; countJobs: (data: any) => number }> = [
  {
    ats: "greenhouse",
    url: (slug) => `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`,
    countJobs: (data) => data.jobs?.length ?? 0,
  },
  {
    ats: "lever",
    url: (slug) => `https://api.lever.co/v0/postings/${slug}?mode=json`,
    countJobs: (data) => (Array.isArray(data) ? data.length : 0),
  },
  {
    ats: "ashby",
    url: (slug) => `https://api.ashbyhq.com/posting-api/job-board/${slug}`,
    countJobs: (data) => data.jobs?.length ?? 0,
  },
];

// A company name can map to more than one plausible slug - try a small set
// of reasonable candidates, cheapest/most-likely first.
function candidateSlugs(name: string, ycSlug: string): string[] {
  const stripped = (s: string) =>
    s
      .toLowerCase()
      .replace(/\b(inc|labs|ai|hq|technologies|the)\b/g, "")
      .trim();

  const noSpaces = stripped(name).replace(/[^a-z0-9]/g, "");
  const hyphenated = stripped(name)
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-");

  return Array.from(new Set([ycSlug, noSpaces, hyphenated].filter(Boolean)));
}

async function checkSlug(slug: string): Promise<{ ats: AtsType; jobCount: number } | null> {
  for (const check of CHECKS) {
    try {
      const res = await fetch(check.url(slug));
      if (res.ok) {
        const data = await res.json();
        const jobCount = check.countJobs(data);
        if (jobCount > 0) return { ats: check.ats, jobCount };
      }
    } catch {
      // network hiccup - treat as a miss for this ATS, move on
    }
  }
  return null;
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

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string, fallback: number) => {
    const idx = args.indexOf(flag);
    return idx >= 0 ? Number(args[idx + 1]) : fallback;
  };
  return { limit: get("--limit", 300), concurrency: get("--concurrency", 6) };
}

async function main() {
  const { limit, concurrency } = parseArgs();

  console.log(`Fetching YC company directory...`);
  const res = await fetch(YC_COMPANIES_URL);
  if (!res.ok) throw new Error(`Failed to fetch YC companies: ${res.status}`);
  const all = (await res.json()) as YcCompany[];

  const candidates = all
    .filter((c) => c.status === "Active" || c.status === "Public")
    .slice(0, limit);

  console.log(`Checking ${candidates.length} companies (concurrency ${concurrency})...\n`);

  let checked = 0;
  const found: Company[] = [];

  await runWithConcurrency(candidates, concurrency, async (yc) => {
    const slugs = candidateSlugs(yc.name, yc.slug);
    for (const slug of slugs) {
      const hit = await checkSlug(slug);
      if (hit) {
        found.push({ slug, name: yc.name, ats: hit.ats });
        console.log(`  ✓ ${yc.name} -> ${slug} (${hit.ats}, ${hit.jobCount} jobs)`);
        break;
      }
    }
    checked++;
    if (checked % 50 === 0) console.log(`  ...${checked}/${candidates.length} checked`);
  });

  await writeFile(DISCOVERED_PATH, JSON.stringify(found, null, 2));
  console.log(`\nDone. ${found.length} hit(s) out of ${candidates.length} checked.`);
  console.log(`Written to data/discovered.json — review, then merge into data/companies.json.`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
