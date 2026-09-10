export type AtsType = "greenhouse" | "lever" | "ashby";

export interface Company {
  slug: string;        // the identifier used in the ATS's own URL/API
  name: string;
  ats: AtsType;
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
}

export interface SeenRecord {
  firstSeenAt: string; // ISO timestamp - our own ground truth for "posted"
}
