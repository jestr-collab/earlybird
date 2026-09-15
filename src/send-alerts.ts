// Sends alert emails via Resend for newly-discovered postings that match a
// subscriber's saved categories + location preference.
//
// Design choice worth flagging: this sends ONE email per subscriber per
// fetch:db run (bundling every new match from that run), not one email per
// individual posting. A run happens every 30 min via launchd, so a
// subscriber still hears about a match within 30 minutes of it going live -
// "instant" in the sense the product promises - but a run that finds 5
// matches for the same person (common right after a new company's whole
// backlog lands at once) sends them 1 email, not 5. Revisit this if the
// product ever wants true one-email-per-posting; for now this is the safer
// default against looking like a spammer on day one.
//
// Requires RESEND_API_KEY in .env - if it's unset, alert sending is skipped
// entirely (logged once, not an error) so the rest of the pipeline keeps
// working while you're still setting Resend up.

import { Resend } from "resend";
import type { TaggedPosting } from "./types.js";
import type { getSupabase } from "./db.js";
import { matchesLocationPref } from "./states.js";

interface SubscriberRow {
  id: string;
  email: string;
  categories: string[];
  location: string[] | null;
  // Which stage(s) they want alerts for - "internship", "entry-level", or
  // both. Unlike location, this is never null/"any" at the schema level
  // (defaults to both, and the CHECK requires at least 1) - there's no
  // "stage doesn't matter" case the way there's a real "any location" case.
  stages: string[];
  // Doubles as the unsubscribe token (see migrations/013_add_unsubscribe.sql)
  // as well as the confirm token - one unguessable-per-subscriber value is
  // enough to prove "this is genuinely the person this email was sent to"
  // for both actions, no need for a second column.
  confirm_token: string;
}

// posting is only ever internship XOR entry-level (see types.ts's
// isInternship/isEntryLevel comment), so this is really "does the
// subscriber want whichever one this posting is" - matches if either flag
// is true and the corresponding stage is in their picked set.
function matchesStagePref(stages: string[], posting: TaggedPosting): boolean {
  return (posting.isInternship && stages.includes("internship")) || (posting.isEntryLevel && stages.includes("entry-level"));
}

// Resend's free tier requires a verified sending domain before you can send
// to arbitrary recipients - until ALERTS_FROM_EMAIL is set to an address on
// a domain you've verified in the Resend dashboard, this falls back to
// Resend's own onboarding.resend.dev sandbox address, which Resend only
// delivers to the account's own verified email. Fine for initial testing,
// not fine for real subscribers - see the setup notes in README/this
// session's chat.
const FROM_ADDRESS = process.env.ALERTS_FROM_EMAIL || "earlybird <onboarding@resend.dev>";

// Same base URL reasoning as send-confirmations.ts - where unsubscribe.html
// (built by build-view.ts alongside view.html/confirm.html) is actually
// hosted, so the link in the footer of every alert email points somewhere
// real.
const SITE_URL = (process.env.SITE_URL || "https://earlybirdcareer.com").replace(/\/+$/, "");

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function renderAlertEmail(matches: TaggedPosting[], unsubscribeUrl: string): string {
  const rows = matches
    .map(
      (p) => `
    <div style="padding:14px 0;border-bottom:1px solid #eee;">
      <div style="font-weight:600;font-size:15px;">${escapeHtml(p.title)}</div>
      <div style="color:#444;font-size:14px;margin-top:2px;">${escapeHtml(p.company)}${p.location ? " · " + escapeHtml(p.location) : ""}</div>
      <a href="${p.url}" style="color:#06c;text-decoration:none;font-size:14px;">View posting &rarr;</a>
    </div>`
    )
    .join("");

  return `<div style="font-family:-apple-system,sans-serif;max-width:560px;margin:0 auto;color:#1a1a1a;">
    <h2 style="font-size:1.15rem;margin-bottom:4px;">${matches.length === 1 ? "A new posting matches your alerts" : `${matches.length} new postings match your alerts`}</h2>
    <p style="color:#666;font-size:13px;margin-top:0;">earlybird found ${matches.length === 1 ? "this" : "these"} within the last 30 minutes.</p>
    ${rows}
    <p style="color:#999;font-size:11px;margin-top:18px;">Don't want these emails? <a href="${unsubscribeUrl}" style="color:#999;">Unsubscribe</a></p>
  </div>`;
}

export async function sendAlerts(supabase: ReturnType<typeof getSupabase>, newPostings: TaggedPosting[]): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.log("  [alerts] RESEND_API_KEY not set - skipping alert emails this run.");
    return;
  }
  if (newPostings.length === 0) return;

  // Only alert subscribers who've clicked their confirmation link - see
  // send-confirmations.ts. Without this, anyone could type in someone
  // else's email on the signup form and have real alert emails go straight
  // to a person who never agreed to receive them.
  const { data: subscribers, error } = await supabase
    .from("subscribers")
    .select("id, email, categories, location, stages, confirm_token")
    .eq("confirmed", true);
  if (error) {
    console.error("  [alerts] failed to load subscribers:", error.message);
    return;
  }
  if (!subscribers || subscribers.length === 0) return;

  const resend = new Resend(apiKey);
  let sent = 0;

  for (const sub of subscribers as SubscriberRow[]) {
    const matches = newPostings.filter(
      (p) =>
        // p.categories can now hold more than one (see categorize.ts) -
        // matches if ANY of the posting's categories is one the subscriber
        // picked, not just the first/only one the old single-category
        // model would have had.
        p.categories.some((c) => sub.categories.includes(c)) &&
        matchesLocationPref(sub.location, p.location) &&
        matchesStagePref(sub.stages, p)
    );
    if (matches.length === 0) continue;

    try {
      const unsubscribeUrl = `${SITE_URL}/unsubscribe.html?token=${sub.confirm_token}`;
      const { error: sendError } = await resend.emails.send({
        from: FROM_ADDRESS,
        to: sub.email,
        subject: matches.length === 1 ? `New match: ${matches[0].title} at ${matches[0].company}` : `${matches.length} new postings match your alerts`,
        html: renderAlertEmail(matches, unsubscribeUrl),
      });
      if (sendError) {
        console.error(`  [alerts] Resend rejected send to ${sub.email}:`, sendError.message);
        continue;
      }
      sent++;
      console.log(`  [alerts] sent to ${sub.email} (${matches.length} match(es))`);
    } catch (err) {
      // Same defensive pattern as insertBatch/fetchCompany - one
      // subscriber's send failing (bad address, transient network issue)
      // shouldn't stop every other subscriber's email from going out.
      console.error(`  [alerts] failed to send to ${sub.email}:`, (err as Error).message);
    }
  }

  if (sent > 0) console.log(`  [alerts] ${sent} alert email(s) sent this run.`);
}
