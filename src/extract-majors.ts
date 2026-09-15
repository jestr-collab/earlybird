// Pulls a "preferred/required major" list out of a posting's description
// text, where one exists. Real-data catch (2026-09-13): sample-majors.ts
// showed this phrasing is extremely consistent across companies -
// "pursuing a bachelor's/master's/PhD ... degree in <majors>", "degree in
// <majors> or a related field", "background in <majors>" - so a single
// pattern family with a captured major-list group covers the large
// majority of cases seen in the wild (Schonfeld, Rocket Lab, Etched,
// Virtu, Optiver, National Information Solutions Cooperative, etc).
//
// This is intentionally separate from categorize.ts's category tagging -
// it's a more literal, higher-precision signal (the posting says the major
// outright) rather than an inference from title/department keywords, and
// it's only available where descriptionText exists (Greenhouse/Lever/Ashby
// today - see those scrapers vs. workday.ts/smartrecruiters.ts, which don't
// fetch full description text at all).

// The anchor before "in <majors>" is either an explicit noun ("degree"/
// "major"/"program"/"discipline") or a bare degree-name ("Bachelor's",
// "PhD", "Doctorate") used directly ("Bachelor's in Mechanical
// Engineering" - no "degree" word at all, seen in real postings). An
// optional parenthetical aside ("(or comparable program)") can sit between
// the anchor and "in" - Schonfeld's "degree (or comparable program) in
// Computer Science" would otherwise never match.
// Real-data catch (2026-09-13, round 2): bullet-list HTML often has no
// terminal punctuation between list items after stripHtml collapses tags to
// spaces (Rocket Lab: "...degree program in Aerospace, ... or Mechanical
// Engineering discipline and have at least one semester of school
// remaining..." - one continuous run-on with no period). Without a stop
// cue there, the capture group ran past the major list into unrelated
// eligibility text, produced a 100+ char blob, and got silently dropped by
// the length filter - losing "Mechanical Engineering" entirely. Added stop
// cues for the run-on continuations actually seen in the wild.
const MAJOR_CLAUSE_PATTERN =
  /(?:degree|major|program|discipline|bachelor'?s?|master'?s?|phd|doctorate|b\.?s\.?|m\.?s\.?)\s*(?:\([^)]{0,40}\)\s*)?in\s+([^.;\n]+?)(?:\s+or\s+(?:a\s+)?(?:related|equivalent|similar|pertinent|comparable)[^.;\n]*|\s+and\s+(?:have|must|be|are|possess)\b|\s+with\s+(?:at least|a\s)\b|\s*\(|\.|;|\n|$)/gi;

// Split a captured major-list string into individual majors. Only splits on
// list separators (comma, "or", "/", "&") - deliberately NOT on bare "and",
// since "and" is at least as likely to be part of a real major/field name
// ("Occupational Health and Safety", "Science, Technology, Engineering, and
// Mathematics") as a list separator, and splitting it apart there produces
// nonsense entries.
function splitMajors(raw: string): string[] {
  return raw
    .split(/,|\bor\b|\/|&/i)
    .map((m) =>
      m
        .trim()
        .replace(/^(?:an?|the)\s+/i, "")
        // trailing generic nouns that rode along with a real major name,
        // e.g. "Mechanical Engineering discipline" -> "Mechanical Engineering"
        .replace(/\s+(?:discipline|field|degree|program|major|study|studies)$/i, "")
        .trim()
    )
    .filter((m) => m.length > 1 && m.length < 60)
    .filter((m) => !isGenericFiller(m));
}

// Catches filler phrases that aren't an actual field of study - "technical
// field", "other quantitative field", "quantitative discipline", bare
// "technical" - by checking whether every word in the phrase comes from a
// small stoplist of hedge words plus an optional trailing generic noun.
const FILLER_WORDS = new Set([
  "a", "an", "the", "other", "another", "related", "similar", "comparable",
  "pertinent", "equivalent", "relevant", "applicable", "technical",
  "quantitative", "industry", "various", "certain",
]);
const GENERIC_NOUNS = new Set(["field", "discipline", "area", "subject", "background"]);

function isGenericFiller(phrase: string): boolean {
  const words = phrase.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const last = words[words.length - 1];
  const body = GENERIC_NOUNS.has(last) ? words.slice(0, -1) : words;
  return body.length === 0 || body.every((w) => FILLER_WORDS.has(w));
}

export function extractMajors(descriptionText: string | undefined): string[] {
  if (!descriptionText) return [];

  const found: string[] = [];
  for (const match of descriptionText.matchAll(MAJOR_CLAUSE_PATTERN)) {
    for (const m of splitMajors(match[1])) {
      const key = m.toLowerCase();
      if (!found.some((f) => f.toLowerCase() === key)) found.push(m);
    }
  }

  return found;
}
