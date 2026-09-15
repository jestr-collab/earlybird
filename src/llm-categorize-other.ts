// One-time backfill: for postings currently stuck in "other" (the term/
// title/company regex signals in categorize.ts, plus the extracted-major
// keyword table, all came up empty), ask an LLM to actually read the job
// description and assign the real category/categories - the thing regex
// fundamentally can't do (e.g. a "Design" title that's actually an
// industrial/mechanical design role, not our "design" = UX/graphic design
// category; or a JD that states "Marketing or Communications major
// preferred" with no matching keyword in categorize.ts's MAJOR_SIGNALS
// table). Shares its prompt/parsing logic with run-db.ts's own use of this
// same LLM read - see llm-categorize.ts.
//
// Real-data catch (2026-09-14): a large majority of the "other" bucket
// turned out to have NO description_text at all - Workday's list API
// doesn't return one, and smartrecruiters.ts deliberately skips fetching it
// (see that file's comment - not worth 1 extra API call per posting across
// the WHOLE pipeline). This script still processes those rows, just with
// title + team + company only, no JD to read - classifyPostingWithLLM()
// tells the model explicitly when that's the case so it stays conservative
// (prefers "other" over a confident-sounding guess) rather than
// hallucinating specifics it can't actually know. category_reason notes
// "(title only, no JD text)" on these so it's always clear which kind of
// read produced a given category.
//
// This script is for BACKFILLING whatever's sitting in "other" right now
// (run it again any time "other" builds back up) - as of 2026-09-14, new
// postings discovered going forward also get this same LLM read
// automatically as part of run-db.ts's regular pipeline, right when
// they're first inserted, so "other" shouldn't build up nearly as fast as
// it used to. See the chat for the cost breakdown either way - a few
// hundred postings at Haiku rates is well under $1.
//
// Requires ANTHROPIC_API_KEY in .env (get one at console.anthropic.com if
// you don't have one - Settings -> API Keys).
//
// Usage: npx tsx src/llm-categorize-other.ts
//        npx tsx src/llm-categorize-other.ts --dry-run   (prints results, writes nothing)
//        npx tsx src/llm-categorize-other.ts --limit 20  (test on a small batch first)

import "dotenv/config";
import { getSupabase } from "./db.js";
import { classifyPostingWithLLM } from "./llm-categorize.js";

const API_KEY = process.env.ANTHROPIC_API_KEY;

// How many LLM calls to have in flight at once. Anthropic's rate limits are
// generous enough at this volume (a few hundred one-time calls) that this
// is mostly about not hammering the API harder than necessary, not about
// actually hitting a limit.
const CONCURRENCY = 8;

interface Row {
  id: string;
  title: string;
  team: string | null;
  company_name: string;
  description_text: string | null;
  category_reason: string | null;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const limitIdx = args.indexOf("--limit");
  const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : undefined;
  return { dryRun, limit };
}

// Simple concurrency-limited map - no need for a library at this scale.
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function main() {
  if (!API_KEY) {
    throw new Error("Missing ANTHROPIC_API_KEY in .env - get one at console.anthropic.com (Settings -> API Keys).");
  }

  const { dryRun, limit } = parseArgs();
  const supabase = getSupabase();

  let query = supabase
    .from("postings")
    .select("id, title, team, company_name, description_text, category_reason")
    .contains("categories", ["other"])
    .or("is_internship.eq.true,is_entry_level.eq.true");

  if (limit) query = query.limit(limit);

  const { data, error } = await query;
  if (error) throw new Error(`fetch failed: ${error.message}`);
  if (!data || data.length === 0) {
    console.log("No 'other' postings found - nothing to do.");
    return;
  }

  const rows = data as Row[];
  console.log(`${rows.length} posting(s) to classify${dryRun ? " (dry run - no writes)" : ""}...\n`);

  const noDescriptionCount = rows.filter((r) => !r.description_text).length;
  console.log(`(${rows.length - noDescriptionCount} have JD text, ${noDescriptionCount} title-only)\n`);

  let changed = 0;
  let stillOther = 0;
  let failed = 0;

  await mapWithConcurrency(rows, CONCURRENCY, async (row) => {
    let result;
    try {
      result = await classifyPostingWithLLM(
        { title: row.title, team: row.team, companyName: row.company_name, descriptionText: row.description_text },
        API_KEY!
      );
    } catch (err) {
      console.error(`  [llm] failed for "${row.title}" (${row.company_name}): ${(err as Error).message}`);
      failed++;
      return;
    }
    if (!result) {
      failed++;
      return;
    }

    const isStillOther = result.categories.length === 1 && result.categories[0] === "other";
    if (isStillOther) {
      stillOther++;
    } else {
      changed++;
      console.log(`  ${row.company_name} — ${row.title}: [${result.categories.join(", ")}] (${result.reason})`);
    }

    if (!dryRun) {
      const newReason = isStillOther
        ? row.category_reason ?? "no signal matched"
        : `${row.category_reason ?? ""}${row.category_reason ? "; " : ""}llm: ${result.reason}`.trim();
      const { error: updateError } = await supabase
        .from("postings")
        .update({ categories: result.categories, category_reason: newReason })
        .eq("id", row.id);
      if (updateError) {
        console.error(`  [db] update failed for ${row.id}: ${updateError.message}`);
      }
    }
  });

  console.log(`\nDone. ${changed} posting(s) recategorized, ${stillOther} confirmed as genuinely "other", ${failed} failed.`);
  if (dryRun) console.log("(dry run - nothing was written; drop --dry-run to apply)");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
