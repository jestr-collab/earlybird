// Sends the double opt-in confirmation email to newly-signed-up subscribers,
// and is the reason send-alerts.ts is safe to trust: without this step,
// anyone could type a friend's email into the signup form on the listing
// page and have real alert emails start landing in that friend's inbox with
// no consent involved. Signup now only creates an unconfirmed row (see
// migrations/011_add_subscriber_confirmation.sql); a subscriber is never
// alerted (send-alerts.ts filters on confirmed = true) until they click the
// link this email sends them, proving they actually own that inbox.
//
// Runs on the same 30-min cadence as the rest of run-db.ts, not on a
// per-signup webhook - there's no backend server sitting between the
// browser and Supabase to trigger this the instant someone signs up (the
// signup panel writes straight to Supabase with the anon key), so this
// just picks up anyone who signed up since the last run. Confirmation
// arriving within 30 min of signup is an acceptable tradeoff for not
// needing to stand up a real server.
//
// Requires RESEND_API_KEY (same as send-alerts.ts) and SITE_URL - the base
// URL where confirm.html (built by build-view.ts alongside view.html) is
// actually hosted, so the link in the email points somewhere real. Falls
// back to the earlybirdcareer.com domain if SITE_URL isn't set, since
// that's the real domain this product is meant to run on - but if the site
// isn't actually deployed there yet, set SITE_URL in .env to wherever it is
// (or a local path) so the link isn't dead.

import { Resend } from "resend";
import { getSupabase } from "./db.js";

interface UnconfirmedSubscriber {
  id: string;
  email: string;
  confirm_token: string;
}

const FROM_ADDRESS = process.env.ALERTS_FROM_EMAIL || "earlybird <onboarding@resend.dev>";
const SITE_URL = (process.env.SITE_URL || "https://earlybirdcareer.com").replace(/\/+$/, "");

function renderConfirmEmail(confirmUrl: string): string {
  return `<div style="font-family:-apple-system,sans-serif;max-width:480px;margin:0 auto;color:#1a1a1a;">
    <h2 style="font-size:1.15rem;margin-bottom:8px;">Confirm your earlybird alerts</h2>
    <p style="color:#444;font-size:14px;line-height:1.5;">Someone (hopefully you) signed up for earlybird internship alerts with this email address. Click below to start receiving them.</p>
    <a href="${confirmUrl}" style="display:inline-block;background:#06c;color:#fff;text-decoration:none;padding:0.6rem 1.1rem;border-radius:6px;font-size:14px;margin:12px 0;">Confirm my alerts</a>
    <p style="color:#999;font-size:12px;line-height:1.5;">If you didn't sign up for this, you can ignore this email - you won't be added or alerted unless you click the link above.</p>
  </div>`;
}

export async function sendConfirmations(supabase: ReturnType<typeof getSupabase>): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.log("  [confirmations] RESEND_API_KEY not set - skipping this run.");
    return;
  }

  // confirmation_sent_at is null: never attempted yet. Not re-sending to
  // confirmed = false rows that already got one - a stuck/never-clicked
  // confirmation shouldn't re-email someone every 30 min forever.
  const { data: pending, error } = await supabase
    .from("subscribers")
    .select("id, email, confirm_token")
    .eq("confirmed", false)
    .is("confirmation_sent_at", null);

  if (error) {
    console.error("  [confirmations] failed to load pending subscribers:", error.message);
    return;
  }
  if (!pending || pending.length === 0) return;

  const resend = new Resend(apiKey);
  let sent = 0;

  for (const sub of pending as UnconfirmedSubscriber[]) {
    const confirmUrl = `${SITE_URL}/confirm.html?token=${sub.confirm_token}`;
    try {
      const { error: sendError } = await resend.emails.send({
        from: FROM_ADDRESS,
        to: sub.email,
        subject: "Confirm your earlybird alerts",
        html: renderConfirmEmail(confirmUrl),
      });
      if (sendError) {
        console.error(`  [confirmations] Resend rejected send to ${sub.email}:`, sendError.message);
        continue;
      }
      // Mark as sent regardless of whether they ever click it - this flag
      // just means "don't send another one automatically," not "they're
      // confirmed." Same defensive per-row try/catch pattern as
      // send-alerts.ts: one bad address shouldn't block everyone else's.
      const { error: updateError } = await supabase
        .from("subscribers")
        .update({ confirmation_sent_at: new Date().toISOString() })
        .eq("id", sub.id);
      if (updateError) {
        console.error(`  [confirmations] sent to ${sub.email} but failed to mark as sent:`, updateError.message);
        continue;
      }
      sent++;
      console.log(`  [confirmations] sent to ${sub.email}`);
    } catch (err) {
      console.error(`  [confirmations] failed to send to ${sub.email}:`, (err as Error).message);
    }
  }

  if (sent > 0) console.log(`  [confirmations] ${sent} confirmation email(s) sent this run.`);
}

// Also runnable standalone (npm run send-confirmations) instead of only as
// part of fetch:db's pipeline - useful for testing the confirmation flow,
// or for catching up any pending confirmations without waiting for the
// next 30-min fetch:db run. Guarded so importing sendAlerts from run-db.ts
// doesn't also trigger this.
if (import.meta.url === `file://${process.argv[1]}`) {
  sendConfirmations(getSupabase()).catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
