// One-time (well, re-runnable) cleanup: the US filter in run-db.ts only
// stops NEW non-US postings from being inserted going forward - it doesn't
// touch rows that were already sitting in Supabase from before the filter
// existed. This script re-checks every existing row against the same
// isUSLocation logic and deletes the ones that fail. Safe to re-run any
// time (e.g. after widening the location blocklist) - it just deletes
// whatever currently doesn't pass.

import { getSupabase } from "./db.js";
import { isUSLocation } from "./location.js";

const PAGE_SIZE = 1000;

async function main() {
  const supabase = getSupabase();

  // Keyset (id-cursor) pagination, not offset/range - offset pagination
  // combined with deleting rows mid-scan silently skips rows: deleting from
  // page 1 shifts everything after it, so page 2's offset range no longer
  // lines up with the rows it was meant to cover. Anchoring on the last id
  // seen instead is stable regardless of what gets deleted in between.
  let lastId: string | null = null;
  let totalChecked = 0;
  let totalDeleted = 0;

  while (true) {
    let query = supabase
      .from("postings")
      .select("id, company_name, title, location")
      .order("id", { ascending: true })
      .limit(PAGE_SIZE);

    if (lastId) query = query.gt("id", lastId);

    const { data, error } = await query;

    if (error) throw new Error(`cleanup fetch failed: ${error.message}`);
    if (!data || data.length === 0) break;

    lastId = data[data.length - 1].id;
    totalChecked += data.length;
    const nonUS = data.filter((row) => !isUSLocation(row.location));

    if (nonUS.length > 0) {
      const ids = nonUS.map((row) => row.id);
      const { error: deleteError } = await supabase.from("postings").delete().in("id", ids);
      if (deleteError) throw new Error(`cleanup delete failed: ${deleteError.message}`);

      totalDeleted += nonUS.length;
      for (const row of nonUS) {
        console.log(`  deleted: ${row.company_name} — ${row.title} (${row.location})`);
      }
    }

    if (data.length < PAGE_SIZE) break;
  }

  console.log(`\nChecked ${totalChecked} posting(s), deleted ${totalDeleted} non-US posting(s).`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
