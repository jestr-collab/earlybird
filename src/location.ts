// US-only filter.
//
// This used to be a blocklist (exclude only recognized non-US signals,
// default to keeping anything else) on the theory that most companies in
// the registry were US-HQ'd startups with a handful of predictable non-US
// offices. That broke down hard once large multinationals (PwC, P&G,
// Merck, Thermo Fisher, ...) got added via Workday - they post to dozens
// of cities worldwide, and a hand-maintained list of "known non-US places"
// can never keep up (real misses caught in production: Melaka, Brno,
// Palermo, Almaty, Petaling Jaya, Rome, Tianjin - all shown as "US only"
// postings before this fix).
//
// This is now an allowlist instead: a posting only counts as US if its
// location string positively shows a US state (name or abbreviation) or
// "USA"/"United States". Every genuine US posting we've seen from these
// ATSs follows "City, State[, USA]" - so this is a much more reliable
// signal than trying to enumerate every non-US place on Earth. The
// tradeoff is real and deliberate: an ambiguous non-US-looking location
// with no US marker (a bare city name, or Workday's "N Locations" bucket
// text) now gets EXCLUDED by default, where it used to be kept. That's the
// right direction of error for a product that explicitly promises "US
// only" - losing a handful of ambiguous multi-site postings is a much
// smaller problem than showing international listings under that promise.
//
// The one case still defaulted to "keep": a completely missing location
// field. That's genuinely uninformative either way, not a specific-but-
// unrecognized place, so there's no better signal to act on.

const US_STATE_NAMES = [
  "alabama", "alaska", "arizona", "arkansas", "california", "colorado",
  "connecticut", "delaware", "florida", "georgia", "hawaii", "idaho",
  "illinois", "indiana", "iowa", "kansas", "kentucky", "louisiana",
  "maine", "maryland", "massachusetts", "michigan", "minnesota",
  "mississippi", "missouri", "montana", "nebraska", "nevada",
  "new hampshire", "new jersey", "new mexico", "new york",
  "north carolina", "north dakota", "ohio", "oklahoma", "oregon",
  "pennsylvania", "rhode island", "south carolina", "south dakota",
  "tennessee", "texas", "utah", "vermont", "virginia", "washington",
  "west virginia", "wisconsin", "wyoming", "district of columbia",
];

const US_STATE_ABBR =
  "al|ak|az|ar|ca|co|ct|de|fl|ga|hi|id|il|in|ia|ks|ky|la|me|md|ma|mi|mn|ms|mo|mt|ne|nv|nh|nj|nm|ny|nc|nd|oh|ok|or|pa|ri|sc|sd|tn|tx|ut|vt|va|wa|wv|wi|wy|dc";

// Abbreviations only count right after a comma ("City, FL") - that's the
// standard US address format these ATSs use, and requiring the comma
// avoids false-matching a two-letter state code that just happens to
// appear inside an unrelated word.
const US_STATE_ABBR_PATTERN = new RegExp(`,\\s*(${US_STATE_ABBR})\\b`, "i");
const US_STATE_NAME_PATTERN = new RegExp(`\\b(${US_STATE_NAMES.join("|").replace(/ /g, "\\s")})\\b`, "i");
// Bare "US" (no periods) is common in "Remote - US" / "Remote - US: Select
// locations" style strings from Greenhouse/Lever - missed by the original
// pattern, which only recognized "usa" or "u.s.a." with literal periods.
const US_COUNTRY_PATTERN = /\b(united states|usa|u\.s\.a?\.?|us)\b/i;

// Unambiguous major US tech-hub cities/regions, for postings that list only
// a bare city with no state - common in Greenhouse/Lever startup postings
// (e.g. "San Francisco" with nothing else). Deliberately limited to cities
// with no real international namesake ambiguity - things like Manchester,
// Cambridge, Birmingham, Bristol, Richmond, and Newcastle are left out on
// purpose because they're also real non-US cities, so including them would
// reopen the exact false-positive hole this file was rewritten to close.
const US_CITY_OR_REGION_NAMES = [
  "san francisco", "sf bay area", "bay area", "silicon valley",
  "san diego", "san jose", "jersey city", "mountain view", "palo alto",
  "menlo park", "sunnyvale", "cupertino", "redwood city", "santa clara",
  "oakland", "los angeles", "seattle", "austin", "denver", "chicago",
  "boston", "new york city", "brooklyn", "manhattan", "atlanta", "miami",
  "pittsburgh", "nashville", "minneapolis", "salt lake city", "las vegas",
  "detroit", "portland", "philadelphia", "houston", "dallas", "phoenix",
];
const US_CITY_OR_REGION_PATTERN = new RegExp(
  `\\b(${US_CITY_OR_REGION_NAMES.join("|").replace(/ /g, "\\s")})\\b`,
  "i"
);

// Display-form abbreviation map (uppercase, e.g. "CA") for the same 50
// states + DC list above - shared by any script that needs to bucket a
// posting's free-text location into a real state for reporting purposes
// (as opposed to isUSLocation's yes/no filter). Kept here rather than
// duplicated per-script (breakdown.ts and quality-check.ts both need this)
// so the two never quietly drift out of sync on which strings map to which
// state.
export const US_STATE_ABBR_BY_NAME: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA",
  colorado: "CO", connecticut: "CT", delaware: "DE", florida: "FL", georgia: "GA",
  hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA",
  kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD",
  massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS",
  missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV",
  "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
  "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK",
  oregon: "OR", pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC",
  "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT",
  virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI",
  wyoming: "WY", "district of columbia": "DC",
};
const STATE_ABBR_SET = new Set(Object.values(US_STATE_ABBR_BY_NAME));
const STATE_NAME_PATTERN = new RegExp(`\\b(${Object.keys(US_STATE_ABBR_BY_NAME).join("|").replace(/ /g, "\\s")})\\b`, "i");
const STATE_ABBR_EXTRACT_PATTERN = new RegExp(`,\\s*(${[...STATE_ABBR_SET].join("|")})\\b`, "i");

// Best-effort state extraction from a free-text location string, for
// REPORTING purposes (breakdown.ts, quality-check.ts) - separate from (and
// less strict than) isUSLocation above, which decides what to store in the
// first place. A bit more guessing is fine here since a wrong bucket just
// skews a diagnostic report, not what a paying subscriber sees.
export function extractState(location: string | null | undefined): string {
  if (!location) return "(no location)";
  const loc = location.trim();
  if (loc.toLowerCase() === "remote") return "Remote (unspecified)";

  const abbrMatch = loc.match(STATE_ABBR_EXTRACT_PATTERN);
  if (abbrMatch) return abbrMatch[1].toUpperCase();

  const nameMatch = loc.match(STATE_NAME_PATTERN);
  if (nameMatch) return US_STATE_ABBR_BY_NAME[nameMatch[1].toLowerCase().replace(/\s+/g, " ")];

  return "Other/Unrecognized";
}

export function isUSLocation(location?: string | null): boolean {
  if (!location) return true; // no location at all - genuinely uninformative, not a specific unrecognized place

  const loc = location.trim();
  if (loc.toLowerCase() === "remote") return true; // bare "Remote" with no place info - ambiguous, keep

  return (
    US_COUNTRY_PATTERN.test(loc) ||
    US_STATE_NAME_PATTERN.test(loc) ||
    US_STATE_ABBR_PATTERN.test(loc) ||
    US_CITY_OR_REGION_PATTERN.test(loc)
  );
}
