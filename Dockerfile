# Runs the pipeline (npm run fetch:db) on a schedule via Railway's cron
# jobs, instead of launchd on Julian's Mac. Built FROM Microsoft's official
# Playwright image rather than a plain Node image + `npx playwright
# install` - that image already has Chromium and every system library
# Chromium needs (libnss3, libatk, etc.) baked in, which a minimal
# nixpacks/Node build does NOT have and will fail on the moment the Workday
# bot-protection fallback (src/browser.ts) actually tries to launch a
# browser. Simpler and more reliable than reconstructing those system deps
# by hand.
#
# Version pinned to match the playwright version actually resolved by
# package-lock.json - if that dependency is ever bumped, bump this tag to
# match, otherwise the Playwright *library* and the Chromium *binary* baked
# into this image drift out of sync and fail at runtime. This happened on
# 2026-09-16: package.json's "^1.47.2" range resolved to 1.63.0 in the
# lockfile, but this image was still pinned to 1.47.2's browser binaries,
# which broke the Workday bot-protection fallback (src/browser.ts) with
# "browserType.launch: Executable doesn't exist" during browser cleanup.
FROM mcr.microsoft.com/playwright:v1.63.0-jammy

# This image ships Node 20, but @supabase/supabase-js's realtime client
# (a transitive dependency, not something this project calls directly)
# now requires Node's native WebSocket support, which only exists on
# Node 22+ - without it, getSupabase() throws immediately with "Node.js
# detected but native WebSocket not found," before a single company gets
# scraped (confirmed 2026-09-16: the cron job "succeeded" in ~30s on
# Node 20 because nothing after this line ever ran). Installing Node 22
# over the image's bundled Node 20 instead of downgrading Supabase or
# hand-rolling a ws polyfill - Playwright's browser binaries aren't tied
# to a specific Node version, so this doesn't affect the Chromium install
# already baked into this base image.
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && node --version

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# No CMD here on purpose - Railway's cron job configuration sets the
# command per-run (npm run fetch:db:prod, see package.json), not baked into
# the image, so the same image/build can be reused if other scheduled
# scripts get added later without needing a separate Dockerfile each time.
