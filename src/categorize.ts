import type { ClassifiedPosting, PostingCategory, TaggedPosting } from "./types.js";
import { extractMajors } from "./extract-majors.js";

// Tags a posting with the field/major it actually belongs to - this is what
// makes the product filterable (the whole point: a finance student
// shouldn't have to scroll past 26 Software Engineer Intern listings to
// find the one relevant posting). Two-tier approach, same idea as
// classify.ts: prefer the ATS's own department/team field when it's usable
// (cheap, usually accurate), fall back to title keywords when it isn't.

// Real-data catch (2026-09-11, round 2): the first version of this only
// matched job-title words like "Scientist"/"Chemist"/"Laboratory" - but the
// bulk of what's actually out there (Merck's 80+ "Future Talent Program"
// sub-functions, Flagship Pioneering's lab co-ops) names the *subfunction*
// instead, in pharma/biotech R&D vocabulary that has nothing to do with the
// word "science": "Discovery Oncology", "Translational Medicine", "Chemical
// Biology", "Vaccines Process R&D", "Biocatalysis", "Pharmacokinetics",
// "Formulation Sciences", "Systems Biology", "Genomics", "Proteomics". One
// shared pattern for both TEAM_SIGNALS and TITLE_SIGNALS so the two don't
// drift out of sync the way the first version did.
// Real-data catch (2026-09-14): sample-other.ts's word-frequency pass on a
// 400-posting sample of the "other" bucket surfaced "pharmacy" ~20 times,
// almost entirely CVS Health / Rite Aid "Pharmacy Intern" postings - a
// health-sciences role with nothing to do with the pharmacology R&D
// vocabulary this pattern already covered. Added here rather than as its
// own category since it's the same audience (pre-health/life-science
// students), not a new field.
// Real-data catch (2026-09-14, round 2): Oshkosh's "Environmental Intern"
// had no title/team signal anywhere ("environmental scientist" required the
// literal word "scientist" too). Bare "environmental" added with a negative
// lookahead excluding "environmental engineer" specifically - that's a
// genuinely different (engineering) role, and without the exclusion it
// would get claimed here before ever reaching the generic engineer
// catch-all at the end of TITLE_SIGNALS.
// "\blab\b" added (round 3) - bare "Lab" (as opposed to already-covered
// "laboratory") from the same word-frequency pass; low collision risk as a
// standalone token in a job title.
const SCIENCE_PATTERN =
  /\bscien(ce|ces|tific|tist)\b|\bchemist(ry)?\b|\bbio-?\w*|microbiolog|toxicolog|immunolog|\bvivarium\b|\bgeolog(y|ist)\b|\becologist\b|environmental(?!\s*engineer)|pharmacolog|pharmacokinetic|pharmac(y|ist)|\bclinical\b|\bvaccine|translational|\boncology\b|formulation|laboratory|\blab\b|regulatory affairs|genomic|proteomic|\bprotein\b|drug discovery/i;

// Department/team strings, matched by substring - ordered so more specific
// matches don't get shadowed by broader ones.
const TEAM_SIGNALS: Array<[RegExp, PostingCategory]> = [
  [/data|analytics|business intelligence/i, "data"],
  [SCIENCE_PATTERN, "science"],
  [/engineer|technology|technical|software|infrastructure|security/i, "engineering"],
  [/design|ux|ui\b/i, "design"],
  [/product management|product\b/i, "product"],
  [/finance|accounting|treasury|tax\b|audit/i, "finance"],
  [/marketing|brand|communications|content/i, "marketing"],
  [/sales|business development|partnerships/i, "sales"],
  [/operations|supply chain|logistics/i, "operations"],
  [/consulting|strategy/i, "consulting"],
  [/people|human resources|\bhr\b|talent|recruiting/i, "hr"],
  [/legal|compliance/i, "legal"],
];

// Title keyword fallback for when there's no usable team/department field
// (common on Lever and Workday, which don't always populate one the way
// Greenhouse/Ashby do).
const TITLE_SIGNALS: Array<[RegExp, PostingCategory]> = [
  [
    // Real-data catch (2026-09-14): this only matched compound phrases
    // ("data scien-", "data analy-", "data engineer") and completely missed
    // titles that say just "Analytics" or "AI" on their own - RTX's "Data
    // Recording Intern", Clarios's "People Analytics & AI Intern", and a
    // whole family of Safelite "<X> Global Early Career Professional"
    // titles ("Predictive Analytics...", "Data Recording...") where the
    // category word is the ENTIRE signal, no surrounding job-title
    // convention at all. Bare \bdata\b and \banalytics\b are broad on
    // purpose - same generosity TEAM_SIGNALS already gives "data" above -
    // but excluded from "data center" specifically, since that's a
    // facilities/infrastructure technician role with a completely
    // different audience than a data/analytics student.
    /data scien|data analy|data engineer|\bml\b|machine learning|\banalytics\b|business intelligence|\bai\b|\bdata\b(?!\s*center)/i,
    "data",
  ],
  [
    // Real-data catch (2026-09-11): this was software-engineering-only, so
    // it completely missed hardware/aerospace/electrical roles - common at
    // the space and hardware startups in the registry (Astro Mechanica,
    // Astranis). "Entry-Level Propulsion Design Engineer", "Power
    // Electronics Intern", "Radiation Effects Engineer Intern" were all
    // falling through to "other" for lack of a software-flavored keyword.
    // Real-data catch (2026-09-14): "cyber security"/"cybersecurity" titles
    // (Disney, Cox, Wellmark, AbbVie) had no "engineer" word at all and were
    // falling through - added as its own alternative rather than folded into
    // "security engineer" so a bare "Cybersecurity Intern" still matches.
    // Semiconductor/fab process terms (Micron's DRAM/lithography/wafer/yield
    // internship titles - dozens of them in one sample, none containing the
    // word "engineer") added the same way: real production-scale postings,
    // not a guessed vocabulary.
    /software engineer|\bswe\b|backend|front.?end|full.?stack|mobile engineer|ios engineer|android engineer|devops|site reliability|platform engineer|qa engineer|test engineer|security engineer|cyber\s*security|firmware|embedded|mechanical engineer|electrical engineer|hardware engineer|propulsion|aerospace|avionics|controls engineer|structural engineer|manufacturing engineer|process engineer|materials engineer|chemical engineer|civil engineer|thermal engineer|validation engineer|integration engineer|electronics engineer|power electronics|design engineer|systems engineer|\bdram\b|\beuv\b|lithography|photomask|wafer|yield (enhancement|technology)|semiconductor|nanoscale/i,
    "engineering",
  ],
  [/product design|ux design|ui design|graphic design|industrial design|user research/i, "design"],
  [/product manager|\bapm\b/i, "product"],
  // Same SCIENCE_PATTERN as TEAM_SIGNALS (see comment above it) - placed
  // ahead of the generic engineering catch-all below so a title like
  // "Discovery Oncology" or "Translational Medicine" gets claimed here
  // rather than falling through to "other" for lack of an "engineer" word.
  [SCIENCE_PATTERN, "science"],
  [
    // Added "supply & trading" / "supply and trading" / bare "trading" -
    // Chevron's TAMU TRIP program ("Supply & Trading ... Intern") was
    // falling through to "other" with no finance-flavored keyword at all.
    // Real-data catch (2026-09-14): the finance-firm coverage added this
    // session (banks, asset managers, insurers) surfaced a whole second
    // vocabulary that "financ"/"accounting" doesn't cover - banking/wealth
    // roles ("Banking Associate", "PWM Intern", "Investments Intern"),
    // insurance roles ("Underwriting", "Claims Representative"), and
    // "actuary" itself (the old \bactuarial\b pattern matched the adjective
    // but not the noun - COUNTRY Financial's "Actuary Intern" was missing
    // it entirely).
    // Real-data catch (2026-09-14, round 3): "portfolio" added from a
    // word-frequency pass on the remaining "other" bucket - almost always
    // finance-context in a job title ("Portfolio Analyst/Management"), low
    // collision risk since a design "portfolio" is a thing designers
    // submit, not something that shows up in a job title itself.
    /financ|accounting|accountant|treasury|\btax\b|audit|controller|fp&a|invest(ment|ing)|credit risk|payments|actuar\w*|supply\s*(&|and)\s*trading|\btrading\b|\bbanking\b|wealth management|\bpwm\b|asset management|equity research|middle office|back office|quantitative research|hedge fund|private equity|fixed income|capital markets|underwrit|claims (representative|adjuster)|\bportfolio\b/i,
    "finance",
  ],
  [
    // Real-data catch (2026-09-14): corporate communications / PR / press
    // titles (Disney, NBCUniversal, Wellmark, PwC) had none of the existing
    // marketing keywords - "communications" was already a TEAM_SIGNAL but
    // never made it into the title fallback.
    /marketing|brand|content creator|social media|\bseo\b|growth marketing|communications|public relations|publicity/i,
    "marketing",
  ],
  [
    // "Solutions Engineer" / "Sales Engineer" are pre-sales technical
    // roles - listed here (ahead of the generic engineering catch-all
    // below) so they land in sales rather than engineering. Real-data catch
    // (2026-09-14): Samsara's "Account Development Representative" titles
    // spell the role out instead of using the "ADR" abbreviation the old
    // pattern only matched as a standalone token.
    // Real-data catch (2026-09-14, round 2): Safelite's "Account Management
    // Global Early Career Professional" had "account" but not the specific
    // "development representative"/"executive" phrasing already covered -
    // added the bare "account manag(er|ement)" form too.
    /sales|business development|\bbdr\b|\badr\b|account development representative|account executive|account manag(er|ement)|partnerships|solutions engineer|sales engineer/i,
    "sales",
  ],
  [
    // Real-data catch (2026-09-14): plain "Manufacturing Intern" (no
    // "engineer" word - Oshkosh, Bosch) and Meijer's many "Retail
    // Management Intern" postings had no operations-flavored keyword.
    // Real-data catch (2026-09-14, round 2): JLL's "Hotels and Hospitality"
    // internship (JLL is commercial real estate/facilities services, not a
    // hotel operator - this is property/hospitality management) and J&J's
    // "Reliability Maintenance Technician Co-op" (plant maintenance, not a
    // design-engineering role - no "engineer" word at all) had nothing
    // operations-flavored to match on.
    // "purchasing" added (round 3) - direct synonym of "procurement" already
    // here, same low-risk word-frequency finding as "portfolio" above.
    /operations|supply chain|logistics|program manager|project manager|procurement|purchasing|manufacturing|retail management|hospitality|facilities management|property management|maintenance technician|reliability (engineer|technician)/i,
    "operations",
  ],
  [
    // Real-data catch (2026-09-14): "consulting" the noun never matched
    // "Consultant" the job title (Guidehouse), and most consulting-firm
    // internship titles here (PA Consulting, Ankura, PwC) say "Advisory"
    // rather than "consult" at all - stemmed to \w* and added "advisory".
    /consult\w*|management consultant|strategy|advisory/i,
    "consulting",
  ],
  [/human resources|\bhr\b|people operations|recruiting|talent acquisition|learning.{0,3}development/i, "hr"],
  [
    // Real-data catch (2026-09-14, round 2): Xcel Energy's "Regulatory
    // Policy Intern" (a utility's government/regulatory-affairs function,
    // not their SCIENCE_PATTERN's pharma-specific "regulatory affairs")
    // had neither "legal" nor "compliance" anywhere in the title.
    /legal|paralegal|counsel|compliance|regulatory (affairs|policy)|public policy|government relations/i,
    "legal",
  ],
  // Last-resort generic catch-all: any title with an unqualified "engineer"
  // or "engineering" that didn't match a more specific category above (e.g.
  // "GTM Engineering Intern") is still overwhelmingly more useful bucketed
  // as engineering than dumped in "other". Deliberately placed last so
  // every more specific pattern - including the sales-engineer carve-out
  // just above - gets first claim.
  [/\bengineer(ing)?\b/i, "engineering"],
];

// Last-resort tier, checked only after both team and title signals come up
// empty. Real-data catch (2026-09-14): Roland Berger (a pure management-
// strategy consulting firm - nothing else) posts internships titled just
// "Intern - Q1 2027" / "Intern - Q2 2027" etc, with team unset - genuinely
// zero category-bearing words anywhere in the posting's title or team.
// Deliberately kept to companies whose ENTIRE business is one category (so
// "every posting from this company is X" is a safe bet), not diversified
// firms like PwC/Deloitte that do audit, tax, and consulting under one
// name - those get classified by their own title/team signals like
// everyone else, correctly landing in different categories per posting.
const COMPANY_SIGNALS: Array<[RegExp, PostingCategory]> = [[/^roland berger$/i, "consulting"]];

// Real-data catch (2026-09-14): powers "it's fine if one job spans multiple
// majors" - each major a posting's own description explicitly states (see
// extract-majors.ts) is independently mapped to a category (first pattern
// to match wins, same convention as every other signal list here), and the
// results are UNIONED with whatever team/title/company signal already
// fired in categorize() below - never a replacement for it. Deliberately a
// separate vocabulary from TEAM_SIGNALS/TITLE_SIGNALS: a major is an
// academic field of study ("Computer Science", "Mechanical Engineering",
// "Finance"), not a job title or department name, so it needs its own
// phrasing rather than reusing job-title patterns that wouldn't match "the
// name of a degree" at all.
const MAJOR_SIGNALS: Array<[RegExp, PostingCategory]> = [
  [
    /computer science|computer engineering|software engineering|electrical engineering|mechanical engineering|civil engineering|chemical engineering|aerospace engineering|industrial engineering|systems engineering|materials (science and )?engineering|robotics|information (technology|systems)/i,
    "engineering",
  ],
  [/data science|statistics|applied math\w*|computational \w+|\banalytics\b/i, "data"],
  // Reuses SCIENCE_PATTERN (the same bio-/chem-/pharma-/health vocabulary
  // every other science signal in this file already shares) rather than a
  // second list that could quietly drift out of sync with it.
  [SCIENCE_PATTERN, "science"],
  [/\bfinance\b|financial|economics|accounting/i, "finance"],
  [/marketing/i, "marketing"],
  [/graphic design|industrial design|product design|user experience|\bux\b/i, "design"],
  [/human resources|organizational (behavior|psychology|development)/i, "hr"],
  [/supply chain|logistics|operations management/i, "operations"],
  [/pre-law|legal studies|political science/i, "legal"],
];

// Real-data catch (2026-09-11): once the engineering pattern grew to cover
// hardware/aerospace terms (30+ alternatives), categoryReason - which used
// to store the whole matched RegExp's .source - turned into an unreadable
// wall of text repeated identically on every engineering posting. The
// classification itself was always correct; the diagnostic field just
// stopped being diagnostic. Report the actual matched substring (e.g.
// "mechanical engineer") instead of the entire pattern that could have
// matched, same idea as the fix already applied to BODY_SIGNALS in
// classify.ts.
function findMatch(
  signals: Array<[RegExp, PostingCategory]>,
  text: string
): { category: PostingCategory; matchedText: string } | null {
  for (const [pattern, category] of signals) {
    const match = pattern.exec(text);
    if (match) return { category, matchedText: match[0] };
  }
  return null;
}

// Real-data catch (2026-09-13): folded preferredMajors extraction in here
// too, rather than as a separate step callers have to remember to run -
// categorize() already receives descriptionText (via ClassifiedPosting ->
// RawPosting) and is the one place every caller (run-db.ts, reclassify.ts)
// already goes through to build a TaggedPosting, so this is the one spot
// that can't get out of sync with it.
export function categorize(posting: ClassifiedPosting): TaggedPosting {
  const preferredMajors = extractMajors(posting.descriptionText);

  const categories = new Set<PostingCategory>();
  const reasons: string[] = [];

  // Same priority order as before (team, then title, then company) - just
  // contributing to a set now instead of returning on the first hit, so
  // the major-derived categories below can still add on top of it.
  let primary: { category: PostingCategory; matchedText: string; source: string } | null = null;
  if (posting.team) {
    const teamMatch = findMatch(TEAM_SIGNALS, posting.team);
    if (teamMatch) primary = { ...teamMatch, source: "team" };
  }
  if (!primary) {
    const titleMatch = findMatch(TITLE_SIGNALS, posting.title);
    if (titleMatch) primary = { ...titleMatch, source: "title" };
  }
  if (!primary) {
    const companyMatch = findMatch(COMPANY_SIGNALS, posting.company);
    if (companyMatch) primary = { category: companyMatch.category, matchedText: posting.company, source: "company" };
  }
  if (primary) {
    categories.add(primary.category);
    reasons.push(`${primary.source}:"${primary.matchedText}"`);
  }

  // Real-data catch (2026-09-14): union in every category the posting's OWN
  // stated majors map to (see MAJOR_SIGNALS above), additive on top of
  // whatever team/title/company already found - never a replacement. A
  // "Computer Science, Data Science, or Statistics" internship is honestly
  // both engineering and data; forcing one answer meant a data student
  // filtering by "data" alone could miss it entirely.
  for (const major of preferredMajors) {
    const majorMatch = findMatch(MAJOR_SIGNALS, major);
    if (majorMatch && !categories.has(majorMatch.category)) {
      categories.add(majorMatch.category);
      reasons.push(`major:"${major}"→${majorMatch.category}`);
    }
  }

  if (categories.size === 0) {
    return { ...posting, categories: ["other"], categoryReason: "no-signal", preferredMajors };
  }

  return { ...posting, categories: [...categories], categoryReason: reasons.join("; "), preferredMajors };
}
