// Bulk company discovery from a third source: interninbox's bundled company
// registry (github.com/hiratinspace/interninbox), a small (~120-company)
// live-verified list across Greenhouse/Lever/Ashby/SmartRecruiters/
// Workable/Recruitee, stored as Python source (src/interninbox/registry.py)
// rather than a markdown table or CSV - a third source shape after
// discover-trackers.ts's markdown tables and discover-registry.ts's CSV,
// which is why this is its own script rather than folded into either.
//
// Real-data catch (2026-09-15): this list skews toward well-known,
// already-tracked tech companies (Stripe, Airbnb, Figma, Anthropic, ...) -
// most entries are very likely already in companies.json, so expect a small
// net-new yield. Worth running anyway specifically for its `tags` field:
// unlike discover-trackers.ts's sources (no field/category metadata at
// all), interninbox tags each company (e.g. Gusto -> ("fintech", "hr")),
// which is a genuinely useful signal for spotting companies relevant to
// categories our other sources don't target (design, hr) even at this
// registry's small scale - logged below so they're easy to spot in the
// output, not filtered to just those tags (a generic add still has value).
//
// Workable and Recruitee entries are silently skipped - not ATS platforms
// this pipeline's scrapers support (see src/scrapers/), same treatment as
// an unrecognized platform in discover-registry.ts. No Workday entries
// exist in this source as of writing.
//
// Like the other discover-*.ts scripts, this deliberately does NOT
// auto-merge into companies.json - it writes hits to discovered.json for a
// human to skim and run merge-discovered.ts on.

import { readFile, writeFile } from "node:fs/promises";
import type { AtsType, Company } from "./types.js";

const REGISTRY_URL = "https://raw.githubusercontent.com/hiratinspace/interninbox/main/src/interninbox/registry.py";

const COMPANIES_PATH = new URL("../data/companies.json", import.meta.url);
const DISCOVERED_PATH = new URL("../data/discovered.json", import.meta.url);

// Maps the short constant names registry.py uses (_G, _L, ...) to the real
// ATS identifiers this pipeline uses. _W (workable) and _R (recruitee) map
// to null - recognized but unsupported, filtered out rather than guessed at.
const ATS_CONST_MAP: Record<string, AtsType | null> = {
  _G: "greenhouse",
  _L: "lever",
  _A: "ashby",
  _S: "smartrecruiters",
  _W: null, // workable - not supported by src/scrapers/
  _R: null, // recruitee - not supported by src/scrapers/
};

interface RegistryEntry {
  name: string;
  ats: AtsType;
  slug: string;
  tags: string[];
}

// One RegistryCompany(...) call per line in the source file (confirmed
// against the real fetched content before writing this, not assumed) -
// matches the ATS constant, slug, name, and an optional tags tuple. size
// and top= are ignored - this pipeline has no use for either.
const ENTRY_PATTERN = /RegistryCompany\(\s*(_\w+)\s*,\s*"([^"]*)"\s*,\s*"([^"]*)"\s*,\s*"[^"]*"\s*(?:,\s*\(([^)]*)\))?/g;

function parseRegistry(source: string): RegistryEntry[] {
  const out: RegistryEntry[] = [];
  for (const m of source.matchAll(ENTRY_PATTERN)) {
    const [, atsConst, slug, name, tagsRaw] = m;
    const ats = ATS_CONST_MAP[atsConst];
    if (ats === undefined) {
      console.warn(`  Unrecognized ATS constant "${atsConst}" for ${name} - source format may have changed, skipping.`);
      continue;
    }
    if (ats === null) continue; // recognized but unsupported platform (workable/recruitee)
    if (!slug || !name) continue;

    const tags = tagsRaw
      ? [...tagsRaw.matchAll(/"([^"]+)"/g)].map((t) => t[1])
      : [];
    out.push({ name, ats, slug, tags });
  }
  return out;
}

// Same liveness check every discover-*.ts script uses - confirms a
// candidate still returns real job data right now, not just that it was in
// the source when last fetched.
async function isLive(entry: RegistryEntry): Promise<boolean> {
  try {
    switch (entry.ats) {
      case "greenhouse": {
        const res = await fetch(`https://boards-api.greenhouse.io/v1/boards/${entry.slug}/jobs`);
        if (!res.ok) return false;
        const data = (await res.json()) as { jobs?: unknown[] };
        return (data.jobs?.length ?? 0) > 0;
      }
      case "lever": {
        const res = await fetch(`https://api.lever.co/v0/postings/${entry.slug}?mode=json`);
        if (!res.ok) return false;
        const data = await res.json();
        return Array.isArray(data) && data.length > 0;
      }
      case "ashby": {
        const res = await fetch(`https://api.ashbyhq.com/posting-api/job-board/${entry.slug}`);
        if (!res.ok) return false;
        const data = (await res.json()) as { jobs?: unknown[] };
        return (data.jobs?.length ?? 0) > 0;
      }
      case "smartrecruiters": {
        const res = await fetch(`https://api.smartrecruiters.com/v1/companies/${entry.slug}/postings?limit=1`);
        if (!res.ok) return false;
        const data = (await res.json()) as { totalFound?: number };
        return (data.totalFound ?? 0) > 0;
      }
      case "workday":
        return false; // not present in this source, but exhaustive switch needs a case
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
  if (!res.ok) throw new Error(`Failed to fetch registry.py: ${res.status}`);
  const source = await res.text();

  const entries = parseRegistry(source);
  console.log(`${entries.length} entries on a supported platform (of the full registry)`);

  const seen = new Set<string>();
  const toCheck: RegistryEntry[] = [];
  for (const entry of entries) {
    const key = `${entry.ats}:${entry.slug}`.toLowerCase();
    if (existingKeys.has(key) || seen.has(key)) continue;
    seen.add(key);
    toCheck.push(entry);
  }

  console.log(`${toCheck.length} new candidate(s) to live-check...`);
  const liveFlags = await runWithConcurrency(toCheck, 8, isLive);
  const foundEntries = toCheck.filter((_, i) => liveFlags[i]);
  const found: Company[] = foundEntries.map((e) => ({ slug: e.slug, name: e.name, ats: e.ats }));

  await writeFile(DISCOVERED_PATH, JSON.stringify(found, null, 2));
  console.log(`\nDone. ${found.length} live hit(s) out of ${toCheck.length} candidate(s) checked.`);

  // Surface tags on anything hit, so a design/hr/etc-relevant addition (the
  // whole reason for mining this particular source, see the file header)
  // is easy to spot rather than buried in a plain name list.
  const tagged = foundEntries.filter((e) => e.tags.length > 0);
  if (tagged.length > 0) {
    console.log("\nTags on found companies (for spotting design/hr/etc-relevant adds):");
    for (const e of tagged) {
      console.log(`  ${e.name}: ${e.tags.join(", ")}`);
    }
  }

  console.log(`\nWritten to data/discovered.json - review, then npm run merge-discovered.`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
