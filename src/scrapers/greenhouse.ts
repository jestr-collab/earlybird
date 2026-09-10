import type { Company, RawPosting } from "../types.js";

// Public, undocumented-but-stable Greenhouse job board API. No auth needed.
// https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true
export async function fetchGreenhouse(company: Company): Promise<RawPosting[]> {
  const url = `https://boards-api.greenhouse.io/v1/boards/${company.slug}/jobs?content=true`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Greenhouse fetch failed for ${company.slug}: ${res.status}`);
  }
  const data = (await res.json()) as {
    jobs: Array<{
      id: number;
      title: string;
      updated_at: string;
      location?: { name?: string };
      departments?: Array<{ name: string }>;
      content?: string; // HTML job description
      absolute_url: string;
    }>;
  };

  return data.jobs.map((job) => ({
    externalId: String(job.id),
    company: company.name,
    ats: "greenhouse" as const,
    title: job.title,
    team: job.departments?.[0]?.name,
    location: job.location?.name,
    descriptionText: job.content ? stripHtml(job.content) : undefined,
    atsUpdatedAt: job.updated_at,
    url: job.absolute_url,
  }));
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}
