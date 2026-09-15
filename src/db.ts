import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import type { Company, TaggedPosting } from "./types.js";

function getEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing ${name} in .env. Copy .env.example to .env and fill in your Supabase project's URL + service role key (Project Settings -> API).`
    );
  }
  return value;
}

export function getSupabase() {
  const url = getEnv("SUPABASE_URL");
  const key = getEnv("SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, key);
}

// Upserts the company registry into the `companies` table. data/companies.json
// stays the editable source of truth - this just keeps the DB in sync with it
// on every run, so postings can reference a real company_id.
export async function syncCompanies(
  supabase: ReturnType<typeof getSupabase>,
  companies: Company[]
): Promise<Map<string, string>> {
  const { data, error } = await supabase
    .from("companies")
    .upsert(
      companies.map((c) => ({ slug: c.slug, name: c.name, ats: c.ats })),
      { onConflict: "slug,ats" }
    )
    .select("id, slug, ats");

  if (error) throw new Error(`syncCompanies failed: ${error.message}`);

  const idByKey = new Map<string, string>();
  for (const row of data ?? []) {
    idByKey.set(`${row.ats}:${row.slug}`, row.id);
  }
  return idByKey;
}

// Inserts every posting for one company in a single request instead of one
// round-trip per posting (the original insertIfNew design - correct, but
// meant a company with hundreds of postings, like Nike, took minutes of
// silent one-by-one network calls that looked like the script had frozen).
// Uses upsert with ignoreDuplicates so rows already seen (by the (ats,
// external_id) unique constraint) are silently skipped in the same call
// rather than erroring - Postgres/PostgREST only returns the rows that were
// actually newly inserted, which is what "new" means here.

// Real-data catch (2026-09-13): a single company's entire batch going up as
// one upsert has two real failure modes, both of which used to lose the
// WHOLE company's postings for that run, not just the bad part:
//  1. Anduril: "canceling statement due to statement timeout" - one big
//     enough batch (several hundred rows, each checked against the
//     (ats, external_id) unique index) can outrun Postgres's statement
//     timeout on its own.
//  2. TJX / Loblaw Companies: a row with a null external_id (see
//     workday.ts's real-data catch - Workday itself sometimes omits it)
//     violates the NOT NULL constraint and fails the entire upsert
//     statement, including every OTHER row that would have succeeded.
// Chunking into smaller upserts fixes both: each chunk is far less likely
// to hit the statement timeout, and a bad row only takes down its own
// chunk (logged and skipped) instead of the whole company.
const INSERT_CHUNK_SIZE = 150;

export async function insertBatch(
  supabase: ReturnType<typeof getSupabase>,
  postings: TaggedPosting[],
  companyId: string | undefined
): Promise<TaggedPosting[]> {
  if (postings.length === 0) return [];

  // Defensive guard at the DB layer too, not just in workday.ts - any
  // future scraper bug that produces a missing externalId should be
  // dropped-and-logged here rather than poisoning its whole chunk.
  const valid = postings.filter((p) => {
    if (!p.externalId) {
      console.warn(`  [${p.company}] posting missing externalId, skipping: ${p.title}`);
      return false;
    }
    return true;
  });
  if (valid.length === 0) return [];

  const inserted: TaggedPosting[] = [];
  for (let i = 0; i < valid.length; i += INSERT_CHUNK_SIZE) {
    const chunk = valid.slice(i, i + INSERT_CHUNK_SIZE);
    const rows = chunk.map((posting) => ({
      external_id: posting.externalId,
      ats: posting.ats,
      company_id: companyId,
      company_name: posting.company,
      title: posting.title,
      team: posting.team,
      location: posting.location,
      description_text: posting.descriptionText,
      url: posting.url,
      ats_updated_at: posting.atsUpdatedAt,
      is_internship: posting.isInternship,
      classifier_reason: posting.classifierReason,
      is_entry_level: posting.isEntryLevel,
      entry_level_reason: posting.entryLevelReason,
      categories: posting.categories,
      category_reason: posting.categoryReason,
      preferred_majors: posting.preferredMajors,
    }));

    const { data, error } = await supabase
      .from("postings")
      .upsert(rows, { onConflict: "ats,external_id", ignoreDuplicates: true })
      .select("external_id");

    if (error) {
      // Log and move to the next chunk rather than throwing - one bad
      // chunk (or one that times out) shouldn't cost every other chunk
      // for this company that would have succeeded fine.
      console.error(`  [${chunk[0]?.company}] insert error (chunk ${i / INSERT_CHUNK_SIZE + 1}): ${error.message}`);
      continue;
    }

    const insertedIds = new Set((data ?? []).map((row: { external_id: string }) => row.external_id));
    inserted.push(...chunk.filter((p) => insertedIds.has(p.externalId)));
  }

  return inserted;
}
