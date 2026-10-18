# CLAUDE.md — 100 Days of Sweat tracker

Context for Claude Code sessions on this project.

## What this is
Alessandro's tracker for the Yes Theory "100 Days of Sweat" challenge: one workout + one Reel/TikTok every day, 17 Oct 2026 → 24 Jan 2027 (day 1 = 2026-10-17, Madrid time). Goals: build an activity habit for mental health, document progress, grow reach on Instagram/TikTok.

## Stack
- Cloudflare Worker (`src/index.js`) serving static assets from `public/` + JSON API
- D1 database `sweat100` — id `f171b6a7-1f21-4991-aa40-55316404b78c` (tables already created in production from `schema.sql`; Day 1 seeded)
- R2 bucket `sweat100-photos` for photo uploads
- Cron every 3 h → `syncAll()` in `src/sync.js` (Instagram API with Instagram Login, TikTok Display API v2)
- Apple Health arrives via an iOS Shortcut POSTing to `/api/ingest/health`
- iPhone widget: `widget/sweat100-widget.js` (Scriptable)
- No build step, no framework. Chart.js is vendored at `public/vendor/chart.umd.min.js`.

## Decisions already made
- Public dashboard, private editing. Single admin password = secret `ADMIN_TOKEN` (Bearer header or HttpOnly cookie `s100`).
- Mood, energy, weight, resting HR, notes and private photos are hidden from the public API (`PUBLIC_DAY_FIELDS` in `src/index.js`).
- A day counts as done if it has an activity, minutes > 0, or Apple Health workout minutes > 0. Manual entries win over Health data; Health only fills empty fields.
- Fitbit: legacy Fitbit Web API shuts down 30 Oct 2026 — don't build on it. Google Health API (`https://health.googleapis.com/v4`) IS feasible for personal use: unverified OAuth client (cap 100 users, review only above that), add own Google account as test user, set the consent screen to In production to avoid 7-day refresh-token expiry in Testing mode, link account in the Google Health mobile app first. Not built yet — next step if Alessandro picks a Fitbit/Pixel Watch. Apple Health Shortcut route already exists.
- Photos resized client-side to 2048 px JPEG before upload (also converts HEIC).
- Instagram insights fetched for max 25 posts per sync to stay under Workers subrequest limits.

## Status (18 Oct 2026)
- Built and tested locally with `wrangler dev` (login, day upsert, health ingest, photo upload/serve, streak, summary, sync error handling).
- NOT yet deployed: user needs `npx wrangler login`, `npx wrangler secret put ADMIN_TOKEN`, `npm run deploy`.
- Instagram/TikTok developer apps not yet created (steps in README).
- Google Health (Fitbit) sync not yet built: add to `src/sync.js` alongside Instagram/TikTok, store tokens in `oauth_tokens` (platform `google_health`), write steps/workout minutes/resting HR into the same `days` columns the Apple Health ingest uses (fill-empty-only).
- Fields not yet built: benchmark tests (5k time, push-ups, pull-ups, plank, burpees) — a likely next addition, e.g. a `benchmarks` table + chart.

## Commands
- `npm run dev` — local server on :8787 (needs `.dev.vars` with `ADMIN_TOKEN=...` and `npm run db:local` once)
- `npm run deploy` — deploy to Cloudflare
- `npx wrangler d1 execute sweat100 --remote --command "SELECT * FROM days"` — query production
- `npx wrangler tail` — live logs
