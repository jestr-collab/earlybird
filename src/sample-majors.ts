// One-off diagnostic: pulls description text from postings currently
// categorized "other" on the three ATSs that actually give us full
// description text for free (Greenhouse/Lever/Ashby - Workday and
// SmartRecruiters don't include it in their list endpoints, see those
// scrapers' comments), and surfaces any sentence that looks like it's
// stating a required/preferred major or degree. The goal is to see what
// that phrasing actually looks like in practice before writing an
// extraction pattern for it - same "look at real data first" approach used
// for every categorize.ts/classify.ts signal so far.
//
// Usage: npx tsx src/sample-majors.ts

import { getSupabase } from "./db.js";

const SAMPLE_SIZE = 150;

// Cast a wide net for candidate sentences, then show the whole sentence so
// it's obvious by eye whether it's a real "preferred major" statement or
// just noise (e.g. "major milestone", "major client").
const MAJOR_SENTENCE_PATTERN =
  /[^.!?]*\b(major(?:ing|s)?|degree\s*(?:in|program)?|pursuing\s+a|currently\s+enrolled|bachelor|master|b\.?s\.?|m\.?s\.?)\b[^.!?]*[.!?]/gi;

async function main() {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from("postings")
    .select("company_name, title, ats, description_text")
    .eq("category", "other")
    .in("ats", ["greenhouse", "lever", "ashby"])
    .not("description_text", "is", null)
    .or("is_internship.eq.true,is_entry_level.eq.true")
    .limit(SAMPLE_SIZE);

  if (error) throw new Error(`sample-majors fetch failed: ${error.message}`);
  if (!data || data.length === 0) {
    console.log("No matching postings found.");
    return;
  }

  console.log(`Sampled ${data.length} "other" posting(s) with description text:\n`);

  let withMajorLanguage = 0;
  for (const row of data as Array<{ company_name: string; title: string; ats: string; description_text: string }>) {
    const matches = row.description_text.match(MAJOR_SENTENCE_PATTERN);
    if (!matches || matches.length === 0) continue;
    withMajorLanguage++;
    console.log(`--- ${row.company_name} (${row.ats}) — ${row.title} ---`);
    for (const m of matches.slice(0, 5)) {
      console.log(`  "${m.trim()}"`);
    }
    console.log("");
  }

  console.log(
    `\n${withMajorLanguage} of ${data.length} sampled "other" postings had at least one major/degree-flavored sentence in the description.`
  );
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
