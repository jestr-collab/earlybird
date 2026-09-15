// A single shared Playwright browser instance, lazily launched on first
// use and reused for the rest of the process - not one browser per
// company. Chromium takes a real amount of time and memory to start, and
// this only exists to get past a handful of bot-protected Workday tenants
// per run (see scrapers/workday-browser.ts), not to run one per company.
//
// run-db.ts calls closeBrowser() once at the end of main() so the process
// actually exits instead of being kept alive by an open browser handle -
// but only if a browser was ever launched, so runs where nothing needed
// the fallback don't pay any Playwright startup cost at all.
import type { Browser } from "playwright";

let browserPromise: Promise<Browser> | null = null;

export async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = import("playwright").then(({ chromium }) =>
      chromium.launch({ headless: true })
    );
  }
  return browserPromise;
}

export async function closeBrowser(): Promise<void> {
  if (!browserPromise) return;
  const browser = await browserPromise;
  await browser.close();
  browserPromise = null;
}
