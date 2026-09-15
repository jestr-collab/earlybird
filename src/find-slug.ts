// Quick tool for growing data/companies.json: given a guessed slug, checks it
// against all three ATS APIs and reports which one (if any) is real.
//
// Usage: npm run find-slug -- <slug> [<slug2> <slug3> ...]
// Example: npm run find-slug -- affirm doordash figma
//
// Tip for finding the slug in the first place: open the company's own
// "careers" link. If it redirects to boards.greenhouse.io/<slug>,
// jobs.lever.co/<slug>, or jobs.ashbyhq.com/<slug>, that's your slug.
// If it doesn't redirect to any of those, it's Workday or a custom board -
// not supported by this phase-1 scaffold yet.

const CHECKS: Array<{
  ats: "greenhouse" | "lever" | "ashby" | "smartrecruiters";
  url: (slug: string) => string;
  count: (data: any) => number;
  // SmartRecruiters answers 200 OK with an empty postings list for ANY
  // slug, even one that doesn't exist - there's no 404 to key off of like
  // the other three ATSs. So a "hit" there only counts if it actually
  // returned at least one posting; for the others res.ok alone was already
  // a reliable signal (0 jobs there still means a real, valid slug).
  requirePositiveCount?: boolean;
}> = [
  {
    ats: "greenhouse",
    url: (slug) => `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`,
    count: (data) => data.jobs.length,
  },
  {
    ats: "lever",
    url: (slug) => `https://api.lever.co/v0/postings/${slug}?mode=json`,
    count: (data) => (data as unknown[]).length,
  },
  {
    ats: "ashby",
    url: (slug) => `https://api.ashbyhq.com/posting-api/job-board/${slug}`,
    count: (data) => data.jobs.length,
  },
  {
    ats: "smartrecruiters",
    url: (slug) => `https://api.smartrecruiters.com/v1/companies/${slug}/postings?limit=1`,
    count: (data) => data.totalFound ?? 0,
    requirePositiveCount: true,
  },
];

async function checkSlug(slug: string) {
  const results: string[] = [];
  for (const check of CHECKS) {
    try {
      const res = await fetch(check.url(slug));
      if (res.ok) {
        const data = await res.json();
        const count = check.count(data);
        if (check.requirePositiveCount && count === 0) continue;
        results.push(`  ✓ ${check.ats}: ${count} job(s) live at this slug`);
      }
    } catch {
      // network error - skip silently, treated same as a non-match below
    }
  }

  console.log(`\n${slug}:`);
  if (results.length === 0) {
    console.log(
      "  ✗ not found on greenhouse, lever, ashby, or smartrecruiters (try Workday, or a different guess at the slug)"
    );
  } else {
    results.forEach((r) => console.log(r));
  }
}

async function main() {
  const slugs = process.argv.slice(2);
  if (slugs.length === 0) {
    console.log("Usage: npm run find-slug -- <slug> [<slug2> ...]");
    process.exit(1);
  }
  for (const slug of slugs) {
    await checkSlug(slug);
  }
}

main();
