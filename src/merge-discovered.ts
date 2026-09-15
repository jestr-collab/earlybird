// Merges data/discovered.json (output of `npm run discover`) into
// data/companies.json. At small volume (a few dozen hits) eyeballing each
// line before merging made sense; at hundreds of hits that's no longer
// realistic. The real safety check here isn't "does this look right" - it's
// that every entry in discovered.json already passed a live check against
// the ATS's own public API (it returned real job data for that exact
// slug), so the worst case of a bad slug guess is a mislabeled company
// name attached to real postings, not fake data. This script just skips
// anything whose (ats, slug) pair is already in the registry and reports
// what it added, so you can spot-check afterward rather than review
// upfront.

import { readFile, writeFile } from "node:fs/promises";
import type { Company } from "./types.js";

const COMPANIES_PATH = new URL("../data/companies.json", import.meta.url);
const DISCOVERED_PATH = new URL("../data/discovered.json", import.meta.url);

async function main() {
  const companies: Company[] = JSON.parse(await readFile(COMPANIES_PATH, "utf-8"));
  const discovered: Company[] = JSON.parse(await readFile(DISCOVERED_PATH, "utf-8"));

  // Real-data catch (2026-09): a tracker-sourced batch once contained
  // "ashby:Gumloop" while the registry already had "ashby:gumloop" - same
  // board, Ashby just doesn't care about slug case. Lowercasing both sides
  // of the key comparison (not the stored slug itself) catches a re-cased
  // duplicate that an exact string match would otherwise wave through.
  const existingKeys = new Set(companies.map((c) => `${c.ats}:${c.slug}`.toLowerCase()));
  const seenInBatch = new Set<string>();

  const toAdd: Company[] = [];
  let skippedExisting = 0;
  let skippedDupeInBatch = 0;

  for (const c of discovered) {
    const key = `${c.ats}:${c.slug}`.toLowerCase();
    if (existingKeys.has(key)) {
      skippedExisting++;
      continue;
    }
    if (seenInBatch.has(key)) {
      skippedDupeInBatch++;
      continue;
    }
    seenInBatch.add(key);
    toAdd.push(c);
  }

  const merged = [...companies, ...toAdd];
  await writeFile(COMPANIES_PATH, JSON.stringify(merged, null, 2));

  console.log(`Before: ${companies.length} companies`);
  console.log(`Added:  ${toAdd.length} new companies`);
  console.log(`Skipped: ${skippedExisting} already in registry, ${skippedDupeInBatch} duplicate within discovered.json`);
  console.log(`After:  ${merged.length} companies\n`);

  console.log("Added:");
  for (const c of toAdd) {
    console.log(`  ${c.name} (${c.ats}: ${c.slug})`);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
