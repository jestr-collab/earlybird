// Batch version of add-workday.ts: reads a CSV of "Company Name,url" rows,
// tests each URL against Workday's API, and merges every working one
// straight into data/companies.json (deduped by slug, like the other
// registry-growing scripts). Prints a summary of what worked, what wasn't
// Workday at all, and what looked like Workday but failed to fetch (likely
// bot-protected - needs a browser session, not supported yet).
//
// CSV format: one row per line, no header needed.
//   Nike,https://nike.wd1.myworkdayjobs.com/nke2/job/.../apply
//   Deloitte,https://deloitte.wd1.myworkdayjobs.com/...
//
// Usage: npm run add-workday-batch -- data/workday-candidates.csv

import { readFile, writeFile } from "node:fs/promises";
import type { Company } from "./types.js";
import { parseWorkdayUrl, fetchWorkday } from "./scrapers/workday.js";

const COMPANIES_PATH = new URL("../data/companies.json", import.meta.url);

function parseCsvLine(line: string): [string, string] | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const commaIdx = trimmed.indexOf(",");
  if (commaIdx < 0) return null;
  const name = trimmed.slice(0, commaIdx).trim();
  const url = trimmed.slice(commaIdx + 1).trim();
  return [name, url];
}

async function main() {
  const csvPath = process.argv[2];
  if (!csvPath) {
    console.log("Usage: npm run add-workday-batch -- <path-to.csv>");
    process.exit(1);
  }

  const raw = await readFile(csvPath, "utf-8");
  const rows = raw.split("\n").map(parseCsvLine).filter((r): r is [string, string] => r !== null);

  console.log(`Testing ${rows.length} candidate(s)...\n`);

  const working: Company[] = [];
  const notWorkday: string[] = [];
  const failed: string[] = [];

  for (const [name, url] of rows) {
    let parsed;
    try {
      parsed = parseWorkdayUrl(url);
    } catch {
      notWorkday.push(name);
      console.log(`  – ${name}: not a myworkdayjobs.com URL, skipping`);
      continue;
    }

    const candidate: Company = { slug: parsed.tenant, name, ats: "workday", workday: parsed };
    try {
      const postings = await fetchWorkday(candidate);
      working.push(candidate);
      console.log(`  ✓ ${name}: ${postings.length} job(s) live`);
    } catch (err) {
      failed.push(name);
      console.log(`  ✗ ${name}: ${(err as Error).message}`);
    }
  }

  if (working.length > 0) {
    const raw = await readFile(COMPANIES_PATH, "utf-8");
    const existing: Company[] = JSON.parse(raw);
    const bySlug = new Map(existing.map((c) => [`${c.slug}:${c.ats}`, c]));
    for (const c of working) bySlug.set(`${c.slug}:${c.ats}`, c);
    const merged = Array.from(bySlug.values()).sort((a, b) => a.name.localeCompare(b.name));
    await writeFile(COMPANIES_PATH, JSON.stringify(merged, null, 2));
  }

  console.log(
    `\nDone. ${working.length} added to data/companies.json, ${notWorkday.length} not on Workday, ${failed.length} failed to fetch (likely bot-protected).`
  );
  if (failed.length > 0) console.log(`Failed: ${failed.join(", ")}`);
  if (notWorkday.length > 0) console.log(`Not Workday: ${notWorkday.join(", ")}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
