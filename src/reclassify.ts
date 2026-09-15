// Re-runs classify() + categorize() against every existing row in Supabase
// and updates the ones whose result changed.
//
// Why this exists: insertBatch() uses upsert(..., { ignoreDuplicates: true })
// keyed on (ats, external_id) - so once a posting has been inserted once, a
// later fetch:db run that re-derives a *different* (correct) classification
// for it is silently discarded, because PostgREST just skips the "duplicate"
// row entirely rather than updating it. Concretely: the classify.ts fix that
// stopped tagging Senior/Staff Retell AI roles as internships only applies
// to postings inserted from here on - the already-stored rows (Senior
// Product Manager, Staff Engineer, etc, still showing is_internship=true)
// keep their old, wrong classification forever unless something goes back
// and re-derives it. That's what this script does.
//
// Safe to re-run any time classify.ts or categorize.ts logic changes - it
// only writes rows whose derived result actually differs from what's
// stored, and only touches the classification/category columns, never
// title/location/etc.

import type { RawPosting } from "./types.js";
import { getSupabase } from "./db.js";
import { classify } from "./classify.js";
import { categorize } from "./categorize.js";

const PAGE_SIZE = 500;
// How many update() calls to have in flight at once. Was previously 1
// (fully sequential) - at 25,000+ postings and growing, one network
// round-trip per changed row meant a run that touches most of the table
// (e.g. after a categoryReason format change, which affects nearly every
// categorized row, not just newly-wrong ones) took 10+ minutes. Supabase
// row-level updates aren't batchable into one request the way inserts are
// (no single-statement "update these 20 rows to these 20 different
// values"), so concurrency is the lever available here.
const UPDATE_CONCURRENCY = 20;

interface Row {
  id: string;
  title: string;
  team: string | null;
  description_text: string | null;
  is_internship: boolean;
  classifier_reason: string;
  is_entry_level: boolean;
  entry_level_reason: string;
  categories: string[] | null;
  category_reason: string;
  preferred_majors: string[] | null;
}

// Same order-independent array comparison as sameMajors below, reused for
// categories now that it's an array too (a same-set-different-order result
// from the Set-based union in categorize() isn't a real change).
function sameCategories(a: string[], b: string[] | null): boolean {
  const bArr = b ?? [];
  if (a.length !== bArr.length) return false;
  const aSorted = [...a].sort();
  const bSorted = [...bArr].sort();
  return aSorted.every((v, i) => v === bSorted[i]);
}

// Order-independent array comparison - preferredMajors is built by
// iterating description text in whatever order phrases appear, which isn't
// meaningfully "the" canonical order, so a same-set-different-order result
// shouldn't be treated as changed (that would make this script re-write
// and re-log every science/engineering posting on every run for no reason).
function sameMajors(a: string[], b: string[] | null): boolean {
  const bArr = b ?? [];
  if (a.length !== bArr.length) return false;
  const aSorted = [...a].sort();
  const bSorted = [...bArr].sort();
  return aSorted.every((v, i) => v === bSorted[i]);
}

async function main() {
  const supabase = getSupabase();

  // Keyset (id-cursor) pagination, same reason as cleanup-non-us.ts: this
  // script writes rows as it goes, and offset pagination combined with
  // concurrent writes can shift later pages out from under the scan.
  let lastId: string | null = null;
  let totalChecked = 0;
  let totalUpdated = 0;

  while (true) {
    let query = supabase
      .from("postings")
      .select(
        "id, title, team, description_text, is_internship, classifier_reason, is_entry_level, entry_level_reason, categories, category_reason, preferred_majors"
      )
      .order("id", { ascending: true })
      .limit(PAGE_SIZE);

    if (lastId) query = query.gt("id", lastId);

    const { data, error } = await query;
    if (error) throw new Error(`reclassify fetch failed: ${error.message}`);
    if (!data || data.length === 0) break;

    lastId = data[data.length - 1].id;
    totalChecked += data.length;

    // Figure out which rows in this page actually changed before touching
    // the network at all - classify()/categorize() are pure and cheap, so
    // there's no reason to interleave that with the slow part.
    const toUpdate: Array<{ row: Row; tagged: ReturnType<typeof categorize> }> = [];
    for (const row of data as Row[]) {
      // Only the fields classify()/categorize() actually read: title, team,
      // descriptionText. The rest are dummy placeholders to satisfy
      // RawPosting's shape - unused by either function's logic.
      const raw: RawPosting = {
        externalId: "",
        company: "",
        ats: "greenhouse",
        title: row.title,
        team: row.team ?? undefined,
        descriptionText: row.description_text ?? undefined,
        url: "",
      };

      const tagged = categorize(classify(raw));

      const changed =
        tagged.isInternship !== row.is_internship ||
        tagged.classifierReason !== row.classifier_reason ||
        tagged.isEntryLevel !== row.is_entry_level ||
        tagged.entryLevelReason !== row.entry_level_reason ||
        !sameCategories(tagged.categories, row.categories) ||
        tagged.categoryReason !== row.category_reason ||
        !sameMajors(tagged.preferredMajors, row.preferred_majors);

      if (changed) toUpdate.push({ row, tagged });
    }

    // Fire off updates UPDATE_CONCURRENCY at a time instead of one at a
    // time - each is still its own request (Supabase has no single-call
    // "update these N rows to these N different values"), but overlapping
    // the network round-trips is the only lever available and cuts wall
    // time roughly proportionally to the concurrency level.
    for (let i = 0; i < toUpdate.length; i += UPDATE_CONCURRENCY) {
      const batch = toUpdate.slice(i, i + UPDATE_CONCURRENCY);
      const results = await Promise.all(
        batch.map(async ({ row, tagged }) => {
          const { error: updateError } = await supabase
            .from("postings")
            .update({
              is_internship: tagged.isInternship,
              classifier_reason: tagged.classifierReason,
              is_entry_level: tagged.isEntryLevel,
              entry_level_reason: tagged.entryLevelReason,
              categories: tagged.categories,
              category_reason: tagged.categoryReason,
              preferred_majors: tagged.preferredMajors,
            })
            .eq("id", row.id);
          return { row, tagged, updateError };
        })
      );

      for (const { row, tagged, updateError } of results) {
        if (updateError) throw new Error(`reclassify update failed for ${row.id}: ${updateError.message}`);
        totalUpdated++;
        console.log(
          `  updated: ${row.title} — internship ${row.is_internship}->${tagged.isInternship}, entry-level ${row.is_entry_level}->${tagged.isEntryLevel} (${tagged.classifierReason})`
        );
      }
    }

    if (data.length < PAGE_SIZE) break;
  }

  console.log(`\nChecked ${totalChecked} posting(s), updated ${totalUpdated} with a changed classification.`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
