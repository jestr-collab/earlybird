// Real-data catch (2026-09): a fetch:db run stalled indefinitely at
// company 921/1343 (TJX, Workday) - no error, no progress, just stuck.
// Every scraper's fetch() call had no timeout at all, so a company whose
// ATS endpoint accepts the TCP connection but never sends a response
// (likely bot-protection silently dropping the request rather than
// rejecting it with a 403 the way most do) hangs forever. Since run-db.ts
// processes companies one at a time, a single stuck request blocks every
// company after it in the run, with nothing visible to explain why.
//
// fetchWithTimeout wraps the global fetch() with an AbortController so a
// hung request throws after DEFAULT_TIMEOUT_MS instead of hanging forever.
// run-db.ts already wraps each company's fetchCompany() call in a
// try/catch that logs and moves on - so throwing here is enough to turn a
// silent full-run stall into "one company logged as a fetch error, rest of
// the run continues normally," with no other changes needed upstream.
const DEFAULT_TIMEOUT_MS = 20_000;

export async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`Request timed out after ${timeoutMs}ms: ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
