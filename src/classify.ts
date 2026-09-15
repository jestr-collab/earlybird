import type { RawPosting, ClassifiedPosting } from "./types.js";

// Phase-1 classifier: rules only, no LLM yet. Every signal is logged in
// `classifierReason` so we can see what's firing (or not) once real data
// flows through, and decide where the rules are wrong before reaching for
// an LLM fallback.

const POSITIVE_TITLE_PATTERNS = [
  /\bintern(ship)?\b/i,
  /\bco-?op\b/i,
  /\bsummer analyst\b/i,
  /\bsummer associate\b/i,
];

// Deliberately NOT internship signals, even though they're "early career":
// "New Grad", "Campus", "Early Career" all show up on full-time entry-level
// roles too (see: Stripe's "Software Engineer, New Grad"). Internships and
// new-grad full-time roles are different products to a college student —
// don't conflate them here. If we want a "new grad" category later, it's a
// separate flag, not folded into isInternship.

const NEGATIVE_TITLE_PATTERNS = [
  /\binternal\b/i, // "Internal Transfer", "Internal Mobility" etc - not an internship
  // Real-data catch (2026-09-10): Samsara and Notion both have New Grad
  // full-time postings whose *body* text mentions "currently enrolled" /
  // "expected graduation" as eligibility boilerplate, which was tripping
  // the body-signal fallback below and misclassifying them as internships.
  // A title that explicitly says "New Grad" is a full-time role, full stop -
  // it overrides any body signal, so this has to be checked before body text.
  /\bnew grad\b/i,
];

const BODY_SIGNALS = [
  /currently enrolled/i,
  /expected graduation/i,
  /class of 20\d{2}/i,
  /degree in progress/i,
  /pursuing a .*degree/i,
];

// Real-data catch (2026-09-11): Retell AI's entire careers page - Senior
// Product Manager, Staff Engineer, Senior Software Engineer (Backend /
// Frontend / Full Stack), Deployment Strategist, Founders Initiatives roles,
// an Enterprise Account Executive - was showing up as "internship" via
// body:class of 20\d{2}. That phrase is apparently generic company
// boilerplate at Retell (unrelated to actual student eligibility), not a
// real internship signal, and the body-signal fallback below had no
// seniority check at all - it fired on ANY posting whose description
// happened to contain one matching phrase, regardless of title.
//
// Two-part fix:
//  1. A title carrying a seniority word (Senior/Staff/Principal/Lead/
//     Manager/Director/VP/Head of) now blocks the body-signal fallback
//     outright - an internship classification should never survive a title
//     that plainly says otherwise.
//  2. A single generic phrase in the body is no longer enough - real
//     internship eligibility paragraphs read like "must be currently
//     enrolled ... expected graduation date ... pursuing a degree", i.e.
//     multiple of these phrases together. One-off boilerplate (a stray
//     "class of 2027" in unrelated marketing copy) won't co-occur with a
//     second signal, so requiring >=2 distinct matches filters it out
//     without needing to see the exact wording causing each false positive.
const BODY_SIGNAL_MIN_MATCHES = 2;

const SENIORITY_NEGATIVE_PATTERNS = [
  /\bsenior\b/i,
  /\bstaff\b/i,
  /\bprincipal\b/i,
  /\blead\b/i,
  /\bmanager\b/i,
  /\bdirector\b/i,
  /\bvp\b/i,
  /\bhead of\b/i,
];

// Entry-level / new-grad track. Intentionally title-only and fairly
// conservative: seniority words are excluded so "New Grad Program
// Manager" style titles still count, but we don't try to infer entry-level
// from years-of-experience body text yet (too noisy across ATSs). This
// deliberately overlaps with the audience the internship track already
// reaches - a soon-to-graduate student - which is the point: bulk up
// relevant volume without diluting what "internship" means above.
const ENTRY_LEVEL_TITLE_PATTERNS = [
  /\bnew grad(uate)?s?\b/i,
  /\bearly career\b/i,
  /\bentry.?level\b/i,
  /\buniversity grad(uate)?\b/i,
  /\brotational program\b/i,
  /\bcampus\b/i,
];

function classifyEntryLevel(posting: RawPosting): { isEntryLevel: boolean; entryLevelReason: string } {
  if (SENIORITY_NEGATIVE_PATTERNS.some((p) => p.test(posting.title))) {
    return { isEntryLevel: false, entryLevelReason: "negative-title-match" };
  }

  const titleMatch = ENTRY_LEVEL_TITLE_PATTERNS.find((p) => p.test(posting.title));
  if (titleMatch) {
    return { isEntryLevel: true, entryLevelReason: `title:${titleMatch.source}` };
  }

  return { isEntryLevel: false, entryLevelReason: "no-signal" };
}

export function classify(posting: RawPosting): ClassifiedPosting {
  if (NEGATIVE_TITLE_PATTERNS.some((p) => p.test(posting.title))) {
    return {
      ...posting,
      isInternship: false,
      classifierReason: "negative-title-match",
      ...classifyEntryLevel(posting),
    };
  }

  const titleMatch = POSITIVE_TITLE_PATTERNS.find((p) => p.test(posting.title));
  if (titleMatch) {
    // A title matching internship patterns never also gets tagged
    // entry-level - they're mutually exclusive by definition.
    return {
      ...posting,
      isInternship: true,
      classifierReason: `title:${titleMatch.source}`,
      isEntryLevel: false,
      entryLevelReason: "internship-takes-precedence",
    };
  }

  if (posting.descriptionText && !SENIORITY_NEGATIVE_PATTERNS.some((p) => p.test(posting.title))) {
    const bodyMatches = BODY_SIGNALS.filter((p) => p.test(posting.descriptionText!));
    if (bodyMatches.length >= BODY_SIGNAL_MIN_MATCHES) {
      return {
        ...posting,
        isInternship: true,
        classifierReason: `body:${bodyMatches.map((p) => p.source).join("+")}`,
        isEntryLevel: false,
        entryLevelReason: "internship-takes-precedence",
      };
    }
  }

  return {
    ...posting,
    isInternship: false,
    classifierReason: "no-signal",
    ...classifyEntryLevel(posting),
  };
}
