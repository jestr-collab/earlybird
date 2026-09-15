// One-off diagnostic: pulls a sample of postings currently stuck in the
// "other" category bucket and surfaces the most common words across their
// titles, so a new category signal can be spotted the same way the
// hardware/aerospace and trading-desk fixes were found earlier - by
// looking at what's actually falling through at real production scale,
// not guessing.
//
// Usage: npx tsx src/sample-other.ts

import { getSupabase } from "./db.js";

const SAMPLE_SIZE = 400;

const STOPWORDS = new Set([
  "the", "and", "for", "with", "intern", "internship", "co", "op", "summer",
  "2026", "2027", "2025", "at", "in", "of", "to", "a", "an", "on", "or",
  "new", "program", "student", "undergraduate", "undergrad", "mba", "phd",
  "year", "round", "term", "us", "usa", "remote", "hybrid", "entry", "level",
  "grad", "graduate", "part", "time", "full",
]);

async function main() {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from("postings")
    .select("company_name, title, team")
    // categories is now an array (a posting can belong to more than one -
    // see categorize.ts) - "other" is only ever the sole element when it
    // appears at all (categorize() never unions "other" with a real
    // category), so .contains is the array-equivalent of the old .eq.
    .contains("categories", ["other"])
    .or("is_internship.eq.true,is_entry_level.eq.true")
    .limit(SAMPLE_SIZE);

  if (error) throw new Error(`sample-other fetch failed: ${error.message}`);
  if (!data || data.length === 0) {
    console.log("No postings currently in the 'other' category.");
    return;
  }

  console.log(`Sampled ${data.length} posting(s) in "other":\n`);
  for (const row of data as Array<{ company_name: string; title: string; team: string | null }>) {
    console.log(`  ${row.company_name} — ${row.title}${row.team ? ` (team: ${row.team})` : ""}`);
  }

  // Word-frequency pass across titles, to surface repeated terms that
  // aren't yet recognized by any TITLE_SIGNALS pattern in categorize.ts -
  // a word showing up a dozen+ times here is a strong candidate for a new
  // signal, the same way "trading" and "propulsion" were found.
  const wordCounts = new Map<string, number>();
  for (const row of data as Array<{ title: string }>) {
    const words = row.title
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
    for (const w of words) wordCounts.set(w, (wordCounts.get(w) ?? 0) + 1);
  }

  console.log("\nMost common words in these titles (candidates for a new categorize.ts signal):");
  const sorted = [...wordCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40);
  for (const [word, count] of sorted) {
    console.log(`  ${String(count).padStart(4)}  ${word}`);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
