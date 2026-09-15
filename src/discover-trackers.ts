// Automated version of the tracker-mining that used to be done by hand each
// session: pulls the public internship-tracker READMEs that the community
// keeps continuously updated (SimplifyJobs' two repos, vanshb03's repo),
// extracts (company, application URL) pairs straight out of each markdown
// table row, and derives (ats, slug) from the URL itself.
//
// Why this is safer than the slug-guessing discover.ts does against the YC
// directory: every candidate here comes from a URL that is, at the moment
// the tracker was last updated, a real, currently-listed application link -
// not a guessed slug that might collide with an unrelated company of the
// same short name. The only risk left is staleness (the tracker maintainer
// hasn't pruned a closed posting yet), which the live-check below catches:
// nothing gets written to discovered.json unless the derived (ats, slug)
// pair still returns real job data right now.
//
// Meant to run on a schedule (see README's launchd section) so the registry
// keeps growing between sessions instead of only when someone sits down and
// mines it by hand. Like discover.ts, this deliberately does NOT auto-merge
// into companies.json - it writes hits to discovered.json for a human to
// skim and run merge-discovered.ts on, same two-step flow as everything
// else in this pipeline.

import { readFile, writeFile } from "node:fs/promises";
import type { AtsType, Company } from "./types.js";
import { parseWorkdayUrl } from "./scrapers/workday.js";

const TRACKER_SOURCES = [
  "https://raw.githubusercontent.com/SimplifyJobs/Summer2027-Internships/dev/README.md",
  "https://raw.githubusercontent.com/SimplifyJobs/Summer2027-Internships/dev/README-Off-Season.md",
  "https://raw.githubusercontent.com/SimplifyJobs/New-Grad-Positions/dev/README.md",
  "https://raw.githubusercontent.com/SimplifyJobs/New-Grad-Positions/dev/README-Off-Season.md",
  "https://raw.githubusercontent.com/vanshb03/Summer2027-Internships/dev/README.md",
];

const COMPANIES_PATH = new URL("../data/companies.json", import.meta.url);
const DISCOVERED_PATH = new URL("../data/discovered.json", import.meta.url);

interface Hit {
  name: string;
  ats: AtsType;
  slug: string;
  workday?: NonNullable<Company["workday"]>;
}

// Turns a real, currently-listed application URL into an (ats, slug) pair.
// Returns null for platforms this registry doesn't scrape (LinkedIn Easy
// Apply mirrors, Handshake, a company's own custom career site, etc) -
// those get silently skipped, never guessed at.
function classifyUrl(url: string): { ats: AtsType; slug: string; workday?: NonNullable<Company["workday"]> } | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  const path = u.pathname.split("/").filter(Boolean);

  if (host === "boards.greenhouse.io" || host === "job-boards.greenhouse.io") {
    // Real-data catch: some trackers' Apply links use Greenhouse's embed
    // widget format (boards.greenhouse.io/embed/job_app?token=8168315)
    // instead of the normal /{slug}/jobs/{id} path - "embed" there is a
    // fixed path segment, not a board slug, and there's no way to recover
    // the real slug from a token without hitting a private Greenhouse
    // endpoint. Skip rather than pass "embed" through as a fake slug (the
    // live-check would reject it anyway, but this avoids the wasted call
    // and the misleading log line).
    if (path[0] === "embed") return null;
    return path[0] ? { ats: "greenhouse", slug: path[0] } : null;
  }
  if (host === "jobs.lever.co") {
    return path[0] ? { ats: "lever", slug: path[0] } : null;
  }
  if (host === "jobs.ashbyhq.com") {
    return path[0] ? { ats: "ashby", slug: path[0] } : null;
  }
  if (host === "jobs.smartrecruiters.com") {
    return path[0] ? { ats: "smartrecruiters", slug: path[0] } : null;
  }
  if (host.endsWith(".myworkdayjobs.com")) {
    try {
      const workday = parseWorkdayUrl(url);
      return { ats: "workday", slug: workday.tenant, workday };
    } catch {
      return null;
    }
  }
  return null;
}

// The tracker repos use two different table syntaxes that both had to be
// checked against real fetched output before trusting either (the first
// draft of this file assumed plain markdown links and would have silently
// found zero rows on every scheduled run):
//   - SimplifyJobs' two repos render raw HTML <tr>/<td>/<a href> blocks,
//     with the company name as the link text: <a href="...">Epic Games</a>
//   - vanshb03's repo uses a markdown pipe table (| Company | Role | ... |)
//     but still embeds the application link as an HTML <a href> inside a
//     cell, not a markdown [text](url) link
// extractLinks() handles both an HTML <a href> and a markdown [text](url)
// link showing up in the same cell, so one code path covers both formats.
function extractLinks(text: string): Array<{ text: string; url: string }> {
  const links: Array<{ text: string; url: string }> = [];
  for (const m of text.matchAll(/<a\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
    links.push({ url: m[1], text: m[2].replace(/<[^>]+>/g, "").trim() });
  }
  for (const m of text.matchAll(/\[([^\]]*)\]\(([^)]+)\)/g)) {
    links.push({ text: m[1].trim(), url: m[2].trim() });
  }
  return links;
}

// Tracker convention: a company with multiple open roles lists the company
// name once, then uses a continuation marker ("↳") for subsequent rows so
// the table doesn't repeat the same name. lastCompanyRef carries the real
// name forward across those rows - a shared mutable ref rather than a
// return value because callers process one row at a time as they're found.
function rowToCandidate(cells: string[], lastCompanyRef: { value: string }): { company: string; applyUrl: string } | null {
  if (cells.length === 0) return null;

  const firstCellLinks = extractLinks(cells[0]);
  const firstText = firstCellLinks.length > 0 ? firstCellLinks[0].text : cells[0].replace(/<[^>]+>/g, "").replace(/\*/g, "").trim();
  const isContinuation = firstText === "" || firstText === "↳";
  const company = isContinuation ? lastCompanyRef.value : firstText;
  if (!isContinuation && company) lastCompanyRef.value = company;
  if (!company) return null;

  // The application link is whichever link in the row resolves to a known
  // ATS host - search every cell, not just one, since column layout and
  // which cell holds the "Apply" link varies by repo.
  for (const cell of cells) {
    for (const link of extractLinks(cell)) {
      if (classifyUrl(link.url)) return { company, applyUrl: link.url };
    }
  }
  return null;
}

function parseTableRows(source: string): Array<{ company: string; applyUrl: string }> {
  const rows: Array<{ company: string; applyUrl: string }> = [];
  const lastCompanyRef = { value: "" };

  if (source.includes("<tr>")) {
    // HTML-table format (SimplifyJobs' repos).
    for (const rowMatch of source.matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
      const cells = [...rowMatch[1].matchAll(/<td>([\s\S]*?)<\/td>/g)].map((m) => m[1]);
      const hit = rowToCandidate(cells, lastCompanyRef);
      if (hit) rows.push(hit);
    }
  } else {
    // Markdown pipe-table format (vanshb03's repo). Header and separator
    // rows (`| Company | ... |`, `|---|---|`) naturally produce no
    // classifiable link and get filtered out without special-casing them.
    for (const line of source.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("|")) continue;
      const cells = trimmed.split("|").slice(1, -1);
      const hit = rowToCandidate(cells, lastCompanyRef);
      if (hit) rows.push(hit);
    }
  }

  return rows;
}

async function fetchTracker(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  return res.text();
}

// Confirms a derived (ats, slug) still returns real job data right now -
// this is what catches a tracker row the maintainer hasn't pruned yet
// (posting closed, slug renamed, etc). Mirrors discover.ts's CHECKS.
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
        // Answers 200 OK with an empty list for ANY slug - see
        // src/scrapers/smartrecruiters.ts - so totalFound > 0 is the real
        // liveness signal here, not just res.ok.
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
        if (!res.ok) return false; // includes bot-protected tenants - conservatively skip, don't add unverifiable ones
        const data = (await res.json()) as { total?: number };
        return (data.total ?? 0) > 0;
      }
    }
  } catch {
    return false; // network hiccup - treat as not-live, safer to miss one than add a dead entry
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
  // Real-data catch: a first run surfaced "ashby:Gumloop" and
  // "ashby:Lightfield" as "new" when "ashby:gumloop" and "ashby:lightfield"
  // were already registered - same board, Ashby just doesn't care about
  // slug case, but an exact string Set did. Lowercase both sides of the
  // comparison so a re-cased slug from a tracker can't slip past the
  // existing-registry check as if it were a brand new company.
  const existingKeys = new Set(companies.map((c) => `${c.ats}:${c.slug}`.toLowerCase()));

  console.log(`Fetching ${TRACKER_SOURCES.length} tracker source(s)...`);
  const candidateRows: Array<{ company: string; applyUrl: string }> = [];
  for (const source of TRACKER_SOURCES) {
    try {
      const markdown = await fetchTracker(source);
      const rows = parseTableRows(markdown);
      console.log(`  ${source}: ${rows.length} row(s) with a recognized ATS link`);
      candidateRows.push(...rows);
    } catch (err) {
      console.error(`  ${source}: fetch error -`, (err as Error).message);
    }
  }

  // Derive (ats, slug) for every row, drop anything already in the
  // registry before spending a network call on it, and de-dupe within this
  // run (the same company/role often appears across multiple tracker
  // sources, or multiple times in one README via re-posted listings).
  const seen = new Set<string>();
  const toCheck: Hit[] = [];
  for (const row of candidateRows) {
    const parsed = classifyUrl(row.applyUrl);
    if (!parsed) continue;
    const key = `${parsed.ats}:${parsed.slug}`.toLowerCase();
    if (existingKeys.has(key) || seen.has(key)) continue;
    seen.add(key);
    toCheck.push({ name: row.company, ...parsed });
  }

  console.log(`\n${toCheck.length} new candidate(s) to live-check...`);
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
