export type AtsType = "greenhouse" | "lever" | "ashby" | "workday" | "smartrecruiters";

export interface Company {
  slug: string;        // the identifier used in the ATS's own URL/API - for
                        // workday, a human-friendly label (tenant is what's
                        // actually used to hit the API, see `workday` below)
  name: string;
  ats: AtsType;
  // Required when ats === "workday" - unlike the other three, Workday has
  // no guessable slug. tenant/wdHost/site come from parsing a real careers
  // URL (see src/scrapers/workday.ts's parseWorkdayUrl and
  // src/add-workday.ts).
  workday?: {
    tenant: string;   // e.g. "nike" in nike.wd1.myworkdayjobs.com
    wdHost: string;   // e.g. "wd1"
    site: string;     // e.g. "nike_careers" - the path segment after any locale
  };
}

// The normalized shape every scraper maps its ATS-specific response into.
// This is what dedupe, classification, and (eventually) storage all operate on.
export interface RawPosting {
  externalId: string;      // ID from the ATS - used for dedupe
  company: string;
  ats: AtsType;
  title: string;
  team?: string;
  location?: string;
  descriptionText?: string; // plain-text snippet, used by the classifier
  atsUpdatedAt?: string;    // timestamp the ATS itself reports, if any (not fully trusted)
  url: string;
}

export interface ClassifiedPosting extends RawPosting {
  isInternship: boolean;
  classifierReason: string; // which signal fired - useful while tuning
  // Separate track from isInternship - new grad / entry-level full-time
  // roles are a different product from an internship, but the audience
  // (a student about to graduate) overlaps enough that we surface both.
  // A posting can be internship OR entry-level, never both.
  isEntryLevel: boolean;
  entryLevelReason: string;
}

// Field/major category - this is what actually makes the product filterable
// (the original pitch: a finance student shouldn't have to wade through
// Software Engineer Intern listings). "other" is a deliberate bucket, not a
// failure state - broad categories with a long tail of one-off titles will
// always have some that don't cleanly fit.
export type PostingCategory =
  | "engineering"
  | "data"
  | "design"
  | "product"
  | "finance"
  | "marketing"
  | "sales"
  | "operations"
  | "consulting"
  | "hr"
  | "legal"
  // Real-data catch (2026-09-11): lab/life-science R&D roles (Merck's
  // "Future Talent Program" alone spans 80+ sub-functions - Bioanalytical
  // Sciences, Discovery Oncology, Vaccines Process R&D, Vivarium, etc -
  // plus Eurofins/Thermo Fisher lab-tech titles and AECOM's environmental
  // science roles) were all falling into "other" with no bucket of their
  // own. Distinct audience from engineering (pharma/biotech/lab science
  // students, not software), so it gets its own category rather than
  // folding into engineering.
  | "science"
  | "other";

export interface TaggedPosting extends ClassifiedPosting {
  // Real-data catch (2026-09-14): this was a single category, forcing a
  // one-or-the-other call on postings that are genuinely cross-listed (a
  // "Computer Science, Data Science, or Statistics" internship is honestly
  // both engineering AND data - picking just one meant a data student
  // filtering by "data" alone could miss it). Now every category the
  // posting's team/title AND stated majors (see MAJOR_SIGNALS in
  // categorize.ts) map to - a union, never fewer entries than the old
  // single-category logic would have produced. Always at least one entry -
  // ["other"] when nothing at all matched.
  categories: PostingCategory[];
  categoryReason: string; // which signal(s) fired, one clause per category - same tuning approach as classify.ts
  // Real-data catch (2026-09-13): a majority (~67% in a sample) of postings
  // with description text explicitly state the required/preferred major(s)
  // - "pursuing a degree in Computer Science, Data Science, ..." - which is
  // a more literal, higher-precision signal than inferring field from
  // title/team keywords. See src/extract-majors.ts. Only populated where
  // descriptionText exists (Greenhouse/Lever/Ashby) - empty array
  // otherwise, not undefined, so downstream code doesn't need a null check.
  // Also now feeds categories directly - see categorize.ts's MAJOR_SIGNALS.
  preferredMajors: string[];
}

export interface SeenRecord {
  firstSeenAt: string; // ISO timestamp - our own ground truth for "posted"
}
