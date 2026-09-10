import type { Company, RawPosting } from "../types.js";

// Public Lever postings API. No auth needed.
// https://api.lever.co/v0/postings/{slug}?mode=json
export async function fetchLever(company: Company): Promise<RawPosting[]> {
  const url = `https://api.lever.co/v0/postings/${company.slug}?mode=json`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Lever fetch failed for ${company.slug}: ${res.status}`);
  }
  const data = (await res.json()) as Array<{
    id: string;
    text: string; // title
    createdAt: number; // epoch ms
    categories?: { team?: string; location?: string; commitment?: string };
    descriptionPlain?: string;
    hostedUrl: string;
  }>;

  return data.map((job) => ({
    externalId: job.id,
    company: company.name,
    ats: "lever" as const,
    title: job.text,
    team: job.categories?.team,
    location: job.categories?.location,
    descriptionText: job.descriptionPlain,
    atsUpdatedAt: new Date(job.createdAt).toISOString(),
    url: job.hostedUrl,
  }));
}
