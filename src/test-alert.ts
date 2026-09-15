// One-off diagnostic: sends a single test email through Resend, completely
// independent of the real pipeline (no Supabase, no subscriber matching, no
// dependency on a genuinely new posting existing). Exists because
// send-alerts.ts only ever fires when fetch:db finds a NEW posting that
// matches someone's saved preferences - which makes it a bad way to debug
// "is Resend/my .env actually working" on its own, since a real failure
// (bad API key, unverified from-address) and a simple "nothing new matched
// this run" look identical from the outside (no email, no error shown to
// you). This isolates the one variable that's actually being tested.
//
// Usage: npx tsx src/test-alert.ts you@example.com

import "dotenv/config";
import { Resend } from "resend";

const FROM_ADDRESS = process.env.ALERTS_FROM_EMAIL || "earlybird <onboarding@resend.dev>";

async function main() {
  const to = process.argv[2];
  if (!to) {
    console.log("Usage: npx tsx src/test-alert.ts you@example.com");
    process.exit(1);
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.error("RESEND_API_KEY is not set in .env - nothing to test yet.");
    process.exit(1);
  }

  console.log(`Sending a test email from "${FROM_ADDRESS}" to ${to}...`);
  const resend = new Resend(apiKey);

  const { data, error } = await resend.emails.send({
    from: FROM_ADDRESS,
    to,
    subject: "earlybird test alert",
    html: `<div style="font-family:-apple-system,sans-serif;">
      <h2>This is a test.</h2>
      <p>If you're reading this, Resend + your .env setup are working end to end.</p>
    </div>`,
  });

  if (error) {
    // Resend's error messages are usually specific enough to act on
    // directly - e.g. "The gmail.com domain is not verified" (using the
    // sandbox address to a non-account email), "Invalid `from` field"
    // (malformed address), "API key is invalid" - printed in full rather
    // than summarized so you don't have to guess what actually failed.
    console.error("Resend rejected the send:");
    console.error(error);
    process.exit(1);
  }

  console.log("Sent. Resend message id:", data?.id);
  console.log("Check the inbox (and spam folder) for", to);
}

main();
