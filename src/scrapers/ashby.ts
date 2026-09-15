import type { Company, RawPosting } from "../types.js";
import { fetchWithTimeout } from "../fetchWithTimeout.js";

// Public Ashby job board API. No auth needed.
// https://api.ashbyhq.com/posting-api/job-board/{slug}
export async function fetchAshby(company: Company): Promise<RawPosting[]> {
  const url = `https://api.ashbyhq.com/posting-api/job-board/${company.slug}`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) {
    throw new Error(`Ashby fetch failed for ${company.slug}: ${res.status}`);
  }
  const data = (await res.json()) as {
    jobs: Array<{
      id: string;
      title: string;
      department?: string;
      location?: string;
      descriptionPlain?: string;
      publishedAt?: string;
      jobUrl: string;
    }>;
  };

  return data.jobs.map((job) => ({
    externalId: job.id,
    company: company.name,
    ats: "ashby" as const,
    title: job.title,
    team: job.department,
    location: job.location,
    descriptionText: job.descriptionPlain,
    atsUpdatedAt: job.publishedAt,
    url: job.jobUrl,
  }));
}
