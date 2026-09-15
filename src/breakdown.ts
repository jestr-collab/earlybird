// One-off diagnostic, not part of the regular pipeline: answers "where are
// the actual gaps" instead of "how many companies do we have" - category
// spread (is every major represented, or mostly engineering?) and
// geographic spread (the thing that actually matters for the "someone in
// Ohio finds nothing" risk) across every currently-stored internship/
// entry-level posting.
//
// Usage: npx tsx src/breakdown.ts

import { getSupabase } from "./db.js";
// extractState moved to location.ts (2026-09-15) so quality-check.ts can
// share the exact same state-bucketing logic instead of a second copy
// quietly drifting out of sync with this one.
import { extractState, US_STATE_ABBR_BY_NAME } from "./location.js";

const PAGE_SIZE = 1000;

interface Row {
  categories: string[] | null;
  location: string | null;
}

async function main() {
  const supabase = getSupabase();

  let lastId: string | null = null;
  const byCategory = new Map<string, number>();
  const byState = new Map<string, number>();
  let total = 0;

  while (true) {
    let query = supabase
      .from("postings")
      .select("id, categories, location")
      .or("is_internship.eq.true,is_entry_level.eq.true")
      .order("id", { ascending: true })
      .limit(PAGE_SIZE);

    if (lastId) query = query.gt("id", lastId);

    const { data, error } = await query;
    if (error) throw new Error(`breakdown fetch failed: ${error.message}`);
    if (!data || data.length === 0) break;

    lastId = (data[data.length - 1] as { id: string }).id;

    for (const row of data as unknown as Row[]) {
      total++;
      // A posting can now belong to more than one category (see
      // categorize.ts's MAJOR_SIGNALS union) - it counts once in EACH of
      // its categories' buckets below, so the "By category" percentages no
      // longer sum to 100% and that's expected, not a bug.
      const cats = row.categories && row.categories.length > 0 ? row.categories : ["(uncategorized)"];
      for (const cat of cats) {
        byCategory.set(cat, (byCategory.get(cat) ?? 0) + 1);
      }

      const state = extractState(row.location);
      byState.set(state, (byState.get(state) ?? 0) + 1);
    }

    if (data.length < PAGE_SIZE) break;
  }

  console.log(`\nTotal internship/entry-level postings: ${total}\n`);

  console.log("By category (a posting can count in more than one - see categories[] - so this can sum past 100%):");
  const catRows = [...byCategory.entries()].sort((a, b) => b[1] - a[1]);
  for (const [cat, count] of catRows) {
    const pct = ((count / total) * 100).toFixed(1);
    console.log(`  ${cat.padEnd(16)} ${String(count).padStart(6)}  (${pct}%)`);
  }

  console.log("\nBy US state (best-effort extraction from the location string - not the strict\nUS-only filter location.ts applies before storage, just a diagnostic grouping):");
  const stateRows = [...byState.entries()].sort((a, b) => b[1] - a[1]);
  for (const [state, count] of stateRows) {
    const pct = ((count / total) * 100).toFixed(1);
    console.log(`  ${state.padEnd(24)} ${String(count).padStart(6)}  (${pct}%)`);
  }

  // The actual "would a real search come up empty" check: how many
  // states got essentially nothing. Anything with 0-1 postings here is a
  // candidate for "someone there finds nothing and wants a refund."
  const allStateAbbrs = new Set(Object.values(US_STATE_ABBR_BY_NAME));
  const thin = [...allStateAbbrs].filter((abbr) => (byState.get(abbr) ?? 0) <= 1);
  console.log(`\n${thin.length} of 51 states/DC have 1 or fewer postings right now:`);
  console.log(`  ${thin.join(", ") || "(none - every state has at least 2)"}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
