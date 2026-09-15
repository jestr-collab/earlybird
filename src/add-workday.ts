// Workday has no guessable slug (unlike find-slug's approach for
// Greenhouse/Lever/Ashby), so this takes a real careers URL you found by
// visiting the company's site, parses out {tenant, wdHost, site}, and
// confirms the API actually works - printing a ready-to-paste
// data/companies.json entry if it does.
//
// How to get the URL: visit the company's "careers" link. If they're on
// Workday, you'll land on (or get redirected to) something like
// https://nike.wd1.myworkdayjobs.com/en-US/nike_careers - that whole URL is
// what you paste in here. If it doesn't look like that, they're not on
// Workday (could be a custom portal, SuccessFactors, iCIMS, etc. - none of
// which this scaffold supports).
//
// Usage: npm run add-workday -- <full careers url> "<Company Name>"
// Example:
//   npm run add-workday -- https://nike.wd1.myworkdayjobs.com/en-US/nike_careers "Nike"

import { parseWorkdayUrl } from "./scrapers/workday.js";
import { fetchWorkday } from "./scrapers/workday.js";

async function main() {
  const [url, name] = process.argv.slice(2);
  if (!url) {
    console.log('Usage: npm run add-workday -- <full careers url> "<Company Name>"');
    process.exit(1);
  }

  let parsed;
  try {
    parsed = parseWorkdayUrl(url);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }

  console.log(`Parsed: tenant=${parsed.tenant} wdHost=${parsed.wdHost} site=${parsed.site}`);
  console.log("Testing the API...");

  try {
    const postings = await fetchWorkday({
      slug: parsed.tenant,
      name: name ?? parsed.tenant,
      ats: "workday",
      workday: parsed,
    });

    console.log(`\n✓ Works - ${postings.length} job(s) live.\n`);
    console.log("Paste this into data/companies.json:\n");
    console.log(
      JSON.stringify(
        {
          slug: parsed.tenant,
          name: name ?? parsed.tenant,
          ats: "workday",
          workday: parsed,
        },
        null,
        2
      )
    );
  } catch (err) {
    console.error(`\n✗ Failed: ${(err as Error).message}`);
    console.error("This tenant may need a browser session (bot protection) - not supported yet.");
  }
}

main();
