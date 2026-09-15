// Coverage/quality audit, not part of the regular pipeline: answers "if a
// real person signs up (or pays) with THIS category + THIS location + THIS
// stage, do they actually get consistent value?" - a different question
// from breakdown.ts's "what does the whole table look like overall."
// breakdown.ts can show "science: 787 postings (17.8%)" and still hide a
// subscriber in Wyoming who's never once gotten a science alert, or a
// category so dominated by one company's mass-posting spree that
// "hundreds of postings" is really "one company, one week, then silence."
//
// Four checks, each aimed at a different way "looks fine in aggregate" can
// still mean "this specific subscriber gets nothing":
//   1. Category x state coverage - which (category, state) pairs have zero
//      or near-zero postings right now (the "signs up in Wyoming" risk).
//   2. Category x state RECENT coverage - same thing, but only postings
//      first_seen in the last RECENT_WINDOW_DAYS. A cell can look fine on
//      lifetime count and still be stale - nothing NEW has landed there in
//      two weeks, so a subscriber's actual "was I alerted this month"
//      experience is empty even though the historical count isn't 0.
//   3. Stage split per category - internship vs entry-level. Total postings
//      skew heavily internship (see breakdown.ts) - a category with decent
//      internship volume can still be nearly empty for an entry-level-only
//      subscriber.
//   4. Company concentration per category - a category can hit a healthy
//      total count while being 60%+ one company's postings, which reads as
//      "occasional huge bursts, long silences" to a real subscriber rather
//      than steady flow.
//
// Usage: npx tsx src/quality-check.ts
//        npx tsx src/quality-check.ts --recent-days 30   (default 14)

import { getSupabase } from "./db.js";
import { extractState, US_STATE_ABBR_BY_NAME } from "./location.js";

const PAGE_SIZE = 1000;
// Below this many total postings, a whole category is thin enough to flag
// on its own, independent of any state/stage breakdown - not enough volume
// for ANY subscriber to that category to expect frequent alerts.
const LOW_VOLUME_CATEGORY_THRESHOLD = 40;
// Above this share of a category coming from one company, flag it as
// "bursty" - alerts arrive in that company's posting waves, not steadily.
const COMPANY_DOMINANCE_THRESHOLD = 0.4;
// A (category, state) cell at or below this lifetime count is treated as
// effectively empty for that combination.
const THIN_CELL_THRESHOLD = 1;

interface Row {
  categories: string[] | null;
  location: string | null;
  is_internship: boolean;
  is_entry_level: boolean;
  company_name: string;
  first_seen_at: string;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const idx = args.indexOf("--recent-days");
  const recentDays = idx !== -1 ? parseInt(args[idx + 1], 10) : 14;
  return { recentDays };
}

interface CategoryStats {
  total: number;
  internship: number;
  entryLevel: number;
  byState: Map<string, number>;
  recentByState: Map<string, number>;
  byCompany: Map<string, number>;
}

function emptyStats(): CategoryStats {
  return { total: 0, internship: 0, entryLevel: 0, byState: new Map(), recentByState: new Map(), byCompany: new Map() };
}

async function main() {
  const { recentDays } = parseArgs();
  const recentCutoff = new Date(Date.now() - recentDays * 24 * 60 * 60 * 1000);
  const supabase = getSupabase();

  let lastId: string | null = null;
  const byCategory = new Map<string, CategoryStats>();
  let total = 0;

  while (true) {
    let query = supabase
      .from("postings")
      .select("id, categories, location, is_internship, is_entry_level, company_name, first_seen_at")
      .or("is_internship.eq.true,is_entry_level.eq.true")
      .order("id", { ascending: true })
      .limit(PAGE_SIZE);

    if (lastId) query = query.gt("id", lastId);

    const { data, error } = await query;
    if (error) throw new Error(`quality-check fetch failed: ${error.message}`);
    if (!data || data.length === 0) break;

    lastId = (data[data.length - 1] as { id: string }).id;

    for (const row of data as unknown as Row[]) {
      total++;
      const cats = row.categories && row.categories.length > 0 ? row.categories : ["(uncategorized)"];
      const state = extractState(row.location);
      const isRecent = new Date(row.first_seen_at) >= recentCutoff;

      for (const cat of cats) {
        const stats = byCategory.get(cat) ?? emptyStats();
        stats.total++;
        if (row.is_internship) stats.internship++;
        if (row.is_entry_level) stats.entryLevel++;
        stats.byState.set(state, (stats.byState.get(state) ?? 0) + 1);
        if (isRecent) stats.recentByState.set(state, (stats.recentByState.get(state) ?? 0) + 1);
        stats.byCompany.set(row.company_name, (stats.byCompany.get(row.company_name) ?? 0) + 1);
        byCategory.set(cat, stats);
      }
    }

    if (data.length < PAGE_SIZE) break;
  }

  console.log(`\nQuality check across ${total} internship/entry-level posting(s), recent window = last ${recentDays} days.\n`);
  console.log("=".repeat(78));

  const allStateAbbrs = [...new Set(Object.values(US_STATE_ABBR_BY_NAME))].sort();
  const categoriesSorted = [...byCategory.entries()].sort((a, b) => b[1].total - a[1].total);

  for (const [cat, stats] of categoriesSorted) {
    console.log(`\n${cat.toUpperCase()}  —  ${stats.total} total (${stats.internship} internship, ${stats.entryLevel} entry-level)`);

    if (stats.total < LOW_VOLUME_CATEGORY_THRESHOLD) {
      console.log(`  ⚠ LOW VOLUME: under ${LOW_VOLUME_CATEGORY_THRESHOLD} postings nationwide - any subscriber to this category alone should expect infrequent alerts regardless of location.`);
    }
    if (stats.entryLevel < 5 && stats.total >= LOW_VOLUME_CATEGORY_THRESHOLD) {
      console.log(`  ⚠ ENTRY-LEVEL THIN: only ${stats.entryLevel} entry-level posting(s) - an entry-level-only subscriber here gets little even though the category overall looks healthy.`);
    }

    // Company concentration - top 3 contributors and whether any one
    // company alone crosses the "bursty" threshold.
    const companyRows = [...stats.byCompany.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
    const topShare = companyRows.length > 0 ? companyRows[0][1] / stats.total : 0;
    const companySummary = companyRows.map(([name, count]) => `${name} (${((count / stats.total) * 100).toFixed(0)}%)`).join(", ");
    console.log(`  Top companies: ${companySummary || "(none)"}`);
    if (topShare >= COMPANY_DOMINANCE_THRESHOLD) {
      console.log(`  ⚠ COMPANY-CONCENTRATED: ${(topShare * 100).toFixed(0)}% of this category is one company - alerts likely arrive in bursts (that company's posting waves) rather than steadily.`);
    }

    // State coverage - lifetime and recent-only.
    const zeroStates = allStateAbbrs.filter((abbr) => (stats.byState.get(abbr) ?? 0) <= THIN_CELL_THRESHOLD);
    const zeroRecentStates = allStateAbbrs.filter((abbr) => (stats.recentByState.get(abbr) ?? 0) === 0);

    console.log(`  States with ${THIN_CELL_THRESHOLD} or fewer lifetime postings: ${zeroStates.length}/51`);
    if (zeroStates.length > 0 && zeroStates.length <= 15) {
      console.log(`    ${zeroStates.join(", ")}`);
    } else if (zeroStates.length > 15) {
      console.log(`    (too many to list - ${zeroStates.slice(0, 15).join(", ")}, ...)`);
    }

    console.log(`  States with 0 postings in the last ${recentDays} days: ${zeroRecentStates.length}/51`);
    if (zeroRecentStates.length > 0 && zeroRecentStates.length <= 15) {
      console.log(`    ${zeroRecentStates.join(", ")}`);
    } else if (zeroRecentStates.length > 15) {
      console.log(`    (too many to list - showing 15: ${zeroRecentStates.slice(0, 15).join(", ")}, ...)`);
    }
  }

  console.log("\n" + "=".repeat(78));
  console.log("\nWhat to do with this: any category flagged LOW VOLUME, or any state showing");
  console.log("up across most categories' \"0 in last N days\" list, is a real coverage gap -");
  console.log("not a classification bug, an actual \"we don't have enough companies posting");
  console.log("there yet\" gap. Fixing it means adding more companies to data/companies.json");
  console.log("in that field/region, not touching the classifier.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
