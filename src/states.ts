// Shared US-state list + location-preference matching, used by both the
// signup panel's location dropdown (build-view.ts) and the alert sender
// (send-alerts.ts) so the two sides of one feature can't drift out of sync
// with each other the way a hand-copied list in each file eventually would.
//
// Deliberately a *different*, narrower contract than location.ts's
// isUSLocation() or breakdown.ts's extractState(): this isn't deciding
// whether a posting counts as "US" at all (that's already settled before a
// posting ever reaches storage) - it's matching one of a small, fixed set
// of subscriber preferences (a state abbreviation, "REMOTE", or "any") back
// against a posting's free-text location string.

export const US_STATES: Array<{ name: string; abbr: string }> = [
  { name: "Alabama", abbr: "AL" }, { name: "Alaska", abbr: "AK" },
  { name: "Arizona", abbr: "AZ" }, { name: "Arkansas", abbr: "AR" },
  { name: "California", abbr: "CA" }, { name: "Colorado", abbr: "CO" },
  { name: "Connecticut", abbr: "CT" }, { name: "Delaware", abbr: "DE" },
  { name: "Florida", abbr: "FL" }, { name: "Georgia", abbr: "GA" },
  { name: "Hawaii", abbr: "HI" }, { name: "Idaho", abbr: "ID" },
  { name: "Illinois", abbr: "IL" }, { name: "Indiana", abbr: "IN" },
  { name: "Iowa", abbr: "IA" }, { name: "Kansas", abbr: "KS" },
  { name: "Kentucky", abbr: "KY" }, { name: "Louisiana", abbr: "LA" },
  { name: "Maine", abbr: "ME" }, { name: "Maryland", abbr: "MD" },
  { name: "Massachusetts", abbr: "MA" }, { name: "Michigan", abbr: "MI" },
  { name: "Minnesota", abbr: "MN" }, { name: "Mississippi", abbr: "MS" },
  { name: "Missouri", abbr: "MO" }, { name: "Montana", abbr: "MT" },
  { name: "Nebraska", abbr: "NE" }, { name: "Nevada", abbr: "NV" },
  { name: "New Hampshire", abbr: "NH" }, { name: "New Jersey", abbr: "NJ" },
  { name: "New Mexico", abbr: "NM" }, { name: "New York", abbr: "NY" },
  { name: "North Carolina", abbr: "NC" }, { name: "North Dakota", abbr: "ND" },
  { name: "Ohio", abbr: "OH" }, { name: "Oklahoma", abbr: "OK" },
  { name: "Oregon", abbr: "OR" }, { name: "Pennsylvania", abbr: "PA" },
  { name: "Rhode Island", abbr: "RI" }, { name: "South Carolina", abbr: "SC" },
  { name: "South Dakota", abbr: "SD" }, { name: "Tennessee", abbr: "TN" },
  { name: "Texas", abbr: "TX" }, { name: "Utah", abbr: "UT" },
  { name: "Vermont", abbr: "VT" }, { name: "Virginia", abbr: "VA" },
  { name: "Washington", abbr: "WA" }, { name: "West Virginia", abbr: "WV" },
  { name: "Wisconsin", abbr: "WI" }, { name: "Wyoming", abbr: "WY" },
  { name: "District of Columbia", abbr: "DC" },
];

// Sentinel values stored in subscribers.location alongside a real state
// abbreviation. Not a state abbreviation itself, so it can't collide with
// one (no real US state abbreviates to "REMOTE").
export const REMOTE_PREF = "REMOTE";

// Matches a single preference value (REMOTE_PREF or a state abbr) against a
// posting's raw location string. Factored out of matchesLocationPref so the
// array-of-prefs case below can just OR these together.
function matchesOnePref(pref: string, location: string): boolean {
  if (pref === REMOTE_PREF) {
    return /\bremote\b/i.test(location);
  }

  const entry = US_STATES.find((s) => s.abbr === pref);
  if (!entry) return false; // defensive - shouldn't happen, the picker only emits real abbrs

  // The abbreviation right after a comma ("City, NY") - the same signal
  // location.ts/breakdown.ts rely on - or after a dash ("Remote - CA"),
  // which those two don't need to handle (a bare "Remote" already passes
  // isUSLocation() either way) but matters here: a subscriber who picked
  // "California" should match a "Remote - CA" posting, not just an
  // on-site "San Francisco, CA" one. Or the full state name appearing
  // anywhere in the string.
  const abbrPattern = new RegExp(`[,-]\\s*${pref}\\b`, "i");
  const namePattern = new RegExp(`\\b${entry.name.replace(/ /g, "\\s")}\\b`, "i");
  return abbrPattern.test(location) || namePattern.test(location);
}

// prefs is exactly what's stored in subscribers.location: null/empty array
// (any location - matches everything), or an array mixing REMOTE_PREF and/or
// two-letter state abbrs from US_STATES (a subscriber can now pick more than
// one - e.g. ["REMOTE", "CA", "NY"]). location is a posting's raw,
// inconsistent location string ("Remote - USA", "New York, NY", "Hybrid -
// Austin, TX"). Matches if the posting satisfies ANY of the subscriber's
// selected prefs (an OR, not an AND - picking CA and NY means "either").
export function matchesLocationPref(prefs: string[] | null | undefined, location: string | null | undefined): boolean {
  if (!prefs || prefs.length === 0) return true; // no preference set - "any location"
  if (!location) return false; // specific location(s) requested but this posting has none at all - can't confirm a match

  return prefs.some((pref) => matchesOnePref(pref, location));
}
