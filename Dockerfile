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
# Version pinned to match the playwright version in package.json
# (^1.47.2) - if that dependency is ever bumped, bump this tag to match,
# otherwise the Playwright *library* and the Chromium *binary* baked into
# this image can drift out of sync and fail at runtime.
FROM mcr.microsoft.com/playwright:v1.47.2-jammy

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# No CMD here on purpose - Railway's cron job configuration sets the
# command per-run (npm run fetch:db:prod, see package.json), not baked into
# the image, so the same image/build can be reused if other scheduled
# scripts get added later without needing a separate Dockerfile each time.
