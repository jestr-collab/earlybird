import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { Company, RawPosting, SeenRecord } from "./types.js";
import { fetchGreenhouse } from "./scrapers/greenhouse.js";
import { fetchLever } from "./scrapers/lever.js";
import { fetchAshby } from "./scrapers/ashby.js";
import { classify } from "./classify.js";

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
  }
}

async function main() {
  const companies = await loadCompanies();
  const seen = await loadSeen();
  const now = new Date().toISOString();

  let newInternshipCount = 0;

  for (const company of companies) {
    let postings: RawPosting[];
    try {
      postings = await fetchCompany(company);
    } catch (err) {
      console.error(`[${company.name}] fetch error:`, (err as Error).message);
      continue;
    }

    for (const posting of postings) {
      const key = seenKey(posting);
      const isNew = !seen[key];

      if (isNew) {
        seen[key] = { firstSeenAt: now };
        const classified = classify(posting);
        if (classified.isInternship) {
          newInternshipCount++;
          console.log(
            `NEW INTERNSHIP  [${classified.classifierReason}]  ${classified.company} — ${classified.title}\n  ${classified.url}`
          );
        }
      }
    }
  }

  await saveSeen(seen);
  console.log(`\nDone. ${newInternshipCount} new internship posting(s) this run.`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
