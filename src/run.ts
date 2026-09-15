import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { Company, RawPosting, SeenRecord } from "./types.js";
import { fetchGreenhouse } from "./scrapers/greenhouse.js";
import { fetchLever } from "./scrapers/lever.js";
import { fetchAshby } from "./scrapers/ashby.js";
import { fetchWorkday } from "./scrapers/workday.js";
import { fetchSmartRecruiters } from "./scrapers/smartrecruiters.js";
import { classify } from "./classify.js";
import { categorize } from "./categorize.js";
import { isUSLocation } from "./location.js";

const COMPANIES_PATH = new URL("../data/companies.json", import.meta.url);
const SEEN_PATH = new URL("../data/seen.json", import.meta.url);

async function loadCompanies(): Promise<Company[]> {
  const raw = await readFile(COMPANIES_PATH, "utf-8");
  return JSON.parse(raw);
}

async function loadSeen(): Promise<Record<string, SeenRecord>> {
  if (!existsSync(SEEN_PATH)) return {};
  const raw = await readFile(SEEN_PATH, "utf-8");
  return JSON.parse(raw);
}

async function saveSeen(seen: Record<string, SeenRecord>): Promise<void> {
  await writeFile(SEEN_PATH, JSON.stringify(seen, null, 2));
}

function seenKey(posting: RawPosting): string {
  return `${posting.ats}:${posting.externalId}`;
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

async function main() {
  const companies = await loadCompanies();
  const seen = await loadSeen();
  const now = new Date().toISOString();

  let newInternshipCount = 0;
  let newEntryLevelCount = 0;
  let droppedNonUSCount = 0;

  for (const [i, company] of companies.entries()) {
    console.log(`[${i + 1}/${companies.length}] ${company.name}...`);

    let postings: RawPosting[];
    try {
      postings = await fetchCompany(company);
    } catch (err) {
      console.error(`  [${company.name}] fetch error:`, (err as Error).message);
      continue;
    }

    for (const posting of postings) {
      if (!isUSLocation(posting.location)) {
        droppedNonUSCount++;
        continue;
      }

      const key = seenKey(posting);
      const isNew = !seen[key];

      if (isNew) {
        seen[key] = { firstSeenAt: now };
        const classified = classify(posting);
        const tagged = categorize(classified);
        if (tagged.isInternship) {
          newInternshipCount++;
          console.log(
            `NEW INTERNSHIP  [${tagged.category}/${tagged.classifierReason}]  ${tagged.company} — ${tagged.title}\n  ${tagged.url}`
          );
        } else if (tagged.isEntryLevel) {
          newEntryLevelCount++;
          console.log(
            `NEW ENTRY-LEVEL [${tagged.category}/${tagged.entryLevelReason}]  ${tagged.company} — ${tagged.title}\n  ${tagged.url}`
          );
        }
      }
    }
  }

  await saveSeen(seen);
  console.log(
    `\nDone. ${newInternshipCount} new internship, ${newEntryLevelCount} new entry-level posting(s) this run (${droppedNonUSCount} non-US postings skipped).`
  );
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
