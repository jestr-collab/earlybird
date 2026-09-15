import type { Company, RawPosting } from "../types.js";
import { fetchWithTimeout } from "../fetchWithTimeout.js";

// Public SmartRecruiters Posting API. No auth needed for public postings.
// https://api.smartrecruiters.com/v1/companies/{slug}/postings
//
// Two real quirks worth knowing before touching this file:
//
// 1. Unlike Greenhouse/Lever/Ashby, this list endpoint does NOT include the
//    full job description - only structured metadata (title, location,
//    department, function, releasedDate, etc). The description lives behind
//    a second per-posting call (GET .../postings/{id}), which would mean one
//    extra request per posting on every fetch cycle - not worth it for what
//    it buys: classify.ts's body-signal fallback is a secondary net, title
//    matching ("Intern", "Co-op", "New Grad", ...) already catches the large
//    majority of postings and doesn't need description text at all. So
//    descriptionText is left undefined here; internship/entry-level
//    detection for SmartRecruiters postings runs on title only.
//
// 2. SmartRecruiters answers 200 OK with an empty content list for *any*
//    slug, even one that doesn't exist - there's no 404 to key off of. That
//    means a "does this slug exist" check has to look at whether any
//    postings came back, not just whether the request succeeded. See
//    find-slug.ts and discover-smartrecruiters.ts.
const PAGE_LIMIT = 100;

interface SmartRecruitersPosting {
  id: string;
  name: string;
  releasedDate?: string;
  location?: {
    city?: string;
    region?: string;
    country?: string;
    remote?: boolean;
  };
  department?: { label?: string };
  function?: { label?: string };
}

interface SmartRecruitersResponse {
  totalFound: number;
  offset: number;
  limit: number;
  content: SmartRecruitersPosting[];
}

function formatLocation(loc?: SmartRecruitersPosting["location"]): string | undefined {
  if (!loc) return undefined;
  if (loc.remote && !loc.city && !loc.country) return "Remote";
  const parts = [loc.city, loc.region, loc.country].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : undefined;
}

export async function fetchSmartRecruiters(company: Company): Promise<RawPosting[]> {
  const postings: RawPosting[] = [];
  let offset = 0;

  while (true) {
    const url = `https://api.smartrecruiters.com/v1/companies/${company.slug}/postings?limit=${PAGE_LIMIT}&offset=${offset}`;
    const res = await fetchWithTimeout(url);
    if (!res.ok) {
      throw new Error(`SmartRecruiters fetch failed for ${company.slug}: ${res.status}`);
    }
    const data = (await res.json()) as SmartRecruitersResponse;

    for (const job of data.content) {
      postings.push({
        externalId: job.id,
        company: company.name,
        ats: "smartrecruiters" as const,
        title: job.name,
        team: job.department?.label ?? job.function?.label,
        location: formatLocation(job.location),
        atsUpdatedAt: job.releasedDate,
        url: `https://jobs.smartrecruiters.com/${company.slug}/${job.id}`,
      });
    }

    offset += data.content.length;
    if (data.content.length < PAGE_LIMIT || offset >= data.totalFound) break;
  }

  return postings;
}
