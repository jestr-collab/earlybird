import type { RawPosting, ClassifiedPosting } from "./types.js";

// Phase-1 classifier: rules only, no LLM yet. Every signal is logged in
// `classifierReason` so we can see what's firing (or not) once real data
// flows through, and decide where the rules are wrong before reaching for
// an LLM fallback.

const POSITIVE_TITLE_PATTERNS = [
  /\bintern(ship)?\b/i,
  /\bco-?op\b/i,
  /\bsummer analyst\b/i,
  /\bcampus\b/i,
  /\bearly career\b/i,
  /\bnew grad\b/i,
];

const NEGATIVE_TITLE_PATTERNS = [
  /\binternal\b/i, // "Internal Transfer", "Internal Mobility" etc - not an internship
];

const BODY_SIGNALS = [
  /currently enrolled/i,
  /expected graduation/i,
  /class of 20\d{2}/i,
  /degree in progress/i,
  /pursuing a .*degree/i,
];

export function classify(posting: RawPosting): ClassifiedPosting {
  if (NEGATIVE_TITLE_PATTERNS.some((p) => p.test(posting.title))) {
    return { ...posting, isInternship: false, classifierReason: "negative-title-match" };
  }

  const titleMatch = POSITIVE_TITLE_PATTERNS.find((p) => p.test(posting.title));
  if (titleMatch) {
    return { ...posting, isInternship: true, classifierReason: `title:${titleMatch.source}` };
  }

  if (posting.descriptionText) {
    const bodyMatch = BODY_SIGNALS.find((p) => p.test(posting.descriptionText!));
    if (bodyMatch) {
      return { ...posting, isInternship: true, classifierReason: `body:${bodyMatch.source}` };
    }
  }

  return { ...posting, isInternship: false, classifierReason: "no-signal" };
}
