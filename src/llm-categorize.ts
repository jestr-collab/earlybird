// Shared LLM categorization logic, used by both the one-time backfill
// script (llm-categorize-other.ts) and the regular pipeline (run-db.ts, as
// of 2026-09-14 - see that file). Pulled into its own module so both
// callers share one prompt/parsing implementation instead of drifting out
// of sync with two copies of the same logic.

import type { PostingCategory } from "./types.js";

export const LLM_MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";

// Keep this in sync with types.ts's PostingCategory union by hand - it's
// small and changes rarely enough that duplicating it here (rather than
// fighting TypeScript to derive a runtime string array from a type) isn't
// worth the complexity.
export const LLM_CATEGORIES: PostingCategory[] = [
  "engineering", "data", "design", "product", "finance", "marketing",
  "sales", "operations", "consulting", "hr", "legal", "science", "other",
];

export interface LLMCategorizeInput {
  title: string;
  team?: string | null;
  companyName: string;
  descriptionText?: string | null;
}

export interface LLMCategorizeResult {
  categories: PostingCategory[];
  reason: string;
}

// Calls the Anthropic Messages API directly via fetch rather than pulling
// in @anthropic-ai/sdk as a dependency - a single POST request doesn't need
// a whole SDK, here or in the pipeline.
export async function classifyPostingWithLLM(input: LLMCategorizeInput, apiKey: string): Promise<LLMCategorizeResult | null> {
  const hasDescription = !!input.descriptionText;

  const prompt = `You're classifying a college internship/entry-level job posting into one or more field categories, based on what major(s) or background the job actually requires - read the job description when there is one, not just the title (titles can be misleading, e.g. "Design Engineer" is engineering, not design).

Allowed categories (pick one or more - a posting can genuinely require multiple majors, e.g. "Computer Science, Data Science, or Statistics" = both engineering and data):
${LLM_CATEGORIES.filter((c) => c !== "other").map((c) => `- ${c}`).join("\n")}
- other (use this if truly nothing about the required background fits any category above)

Posting:
Company: ${input.companyName}
Title: ${input.title}
Team: ${input.team ?? "(not specified)"}
Description: ${hasDescription ? input.descriptionText!.slice(0, 3000) : "(no description text available for this posting - classify from title/team/company alone)"}

${hasDescription ? "" : 'IMPORTANT: there is no job description here, only title/team/company. Be conservative - only pick a category the title itself makes reasonably clear (e.g. "Mechanical Engineering Intern" -> engineering is fine; a vague title like "Summer Analyst" with nothing else to go on should be "other" rather than a guess).\n\n'}Respond with ONLY a JSON object, no other text, in this exact shape:
{"categories": ["engineering"], "reason": "one short clause explaining why"}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      max_tokens: 300,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Anthropic API ${res.status}: ${body.slice(0, 300)}`);
  }

  const data = (await res.json()) as { content: Array<{ type: string; text?: string }> };
  const text = data.content.find((c) => c.type === "text")?.text ?? "";

  // Models occasionally wrap JSON in a code fence despite instructions -
  // strip that before parsing rather than failing the whole row over it.
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");

  let parsed: { categories?: string[]; reason?: string };
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    console.error(`  [llm] unparseable response for "${input.title}": ${text.slice(0, 200)}`);
    return null;
  }

  let categories = (parsed.categories ?? []).filter((c): c is PostingCategory =>
    LLM_CATEGORIES.includes(c as PostingCategory)
  );
  if (categories.length === 0) categories.push("other");

  // Real-data catch (2026-09-14): the model occasionally returns
  // ["operations", "other"] - a real category alongside "other" - on a
  // vague title-only posting, apparently hedging. categorize.ts's regex
  // signals never produce that combination (a real category means "other"
  // never gets unioned in), and sample-other.ts / breakdown.ts both assume
  // "other" only ever appears as the sole element. Drop "other" whenever a
  // real category is also present, rather than letting the invariant break
  // and quietly inflate "other" counts downstream.
  if (categories.length > 1) categories = categories.filter((c) => c !== "other");

  const reason = parsed.reason ?? "llm classification";
  return { categories, reason: hasDescription ? reason : `${reason} (title only, no JD text)` };
}
