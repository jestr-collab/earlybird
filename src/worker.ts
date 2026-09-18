// The actual Cloudflare Worker entry point for this project. Real-data
// catch (2026-09-18): this project deploys via `npx wrangler deploy` (a
// Worker-with-static-assets), not classic Cloudflare Pages - the two are
// different deploy models on Cloudflare, and only classic Pages
// auto-detects a functions/ directory into serverless routes. Under
// `wrangler deploy`, that auto-detection never happens: wrangler explicitly
// asks "is this a Pages deployment?" during setup and, running
// non-interactively in Cloudflare's CI build, always answers "no" - so
// functions/api/create-checkout-session.ts and functions/api/stripe-webhook.ts
// sat there fully written but never actually deployed, 404ing on every
// request (including every real Stripe webhook delivery) until this file
// existed. Those two files' logic now lives in src/api/checkout.ts and
// src/api/webhook.ts as plain exported functions, called from here instead
// of relying on Cloudflare's Pages-only auto-routing. The functions/
// directory itself should be deleted - it's dead code under this deploy
// model, not a working parallel implementation.
//
// How this works: wrangler.jsonc's `assets.directory` (public/) still
// serves every static file exactly as before (app.html, index.html,
// confirm.html, unsubscribe.html) - Cloudflare serves matching static
// requests automatically without ever reaching this fetch handler, only
// falling through to the code below for paths that don't match a static
// file, which in practice means just /api/*.
import { handleCreateCheckoutSession, type Env as CheckoutEnv } from "./api/checkout.js";
import { handleStripeWebhook, type Env as WebhookEnv } from "./api/webhook.js";

type Env = CheckoutEnv & WebhookEnv & { ASSETS: Fetcher };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/create-checkout-session" && request.method === "POST") {
      return handleCreateCheckoutSession(request, env);
    }

    if (url.pathname === "/api/stripe-webhook" && request.method === "POST") {
      return handleStripeWebhook(request, env);
    }

    // Anything else that reaches the Worker (rather than being served
    // directly as a static asset) - fall back to the assets binding so a
    // typo'd path still gets Cloudflare's normal static 404 page instead of
    // an unhandled-route error from this Worker.
    return env.ASSETS.fetch(request);
  },
};
