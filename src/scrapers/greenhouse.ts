import type { Company, RawPosting } from "../types.js";
import { fetchWithTimeout } from "../fetchWithTimeout.js";

// Public, undocumented-but-stable Greenhouse job board API. No auth needed.
// https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true
export async function fetchGreenhouse(company: Company): Promise<RawPosting[]> {
  const url = `https://boards-api.greenhouse.io/v1/boards/${company.slug}/jobs?content=true`;
  const res = await fetchWithTimeout(url);
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

// Real-data catch (2026-09-13): a chunk of Greenhouse companies' job
// descriptions - anything pasted into the Greenhouse editor from Word/Google
// Docs, which turns out to be common - come back with their HTML
// *entity-encoded*, e.g. the literal text "&lt;li&gt;" instead of a real "<li>"
// tag. The old version of this function only stripped real "<...>" tags, so
// none of that encoded markup was ever removed - descriptionText for those
// postings was full of "&lt;/span&gt;&lt;span data-ccp-props=&quot;...&quot;&gt;"
// noise. Some of it is even double-encoded (Word's own paste-cleanup
// re-escaping already-escaped text), so this decodes entities, strips
// whatever real tags that decoding exposed, and decodes once more to catch
// anything left over - each step is a no-op on content that wasn't encoded
// in the first place, so this is safe for every other Greenhouse company too.
function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

function stripHtml(html: string): string {
  const pass1 = decodeEntities(html).replace(/<[^>]*>/g, " ");
  return decodeEntities(pass1).replace(/\s+/g, " ").trim();
}
