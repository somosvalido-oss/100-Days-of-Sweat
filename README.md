# 100 Days of Sweat — tracker

Public dashboard + private logging for the challenge (17 Oct 2026 → 24 Jan 2027), running on Cloudflare.

- **Dashboard** (`/`) — anyone with the link: day counter, streak, the 100-square sheet, minutes, Reel views, followers, public photos.
- **Log** (`/log.html`) — password protected: workout, minutes, intensity, mood, energy, weight, resting HR, Reel, notes, photos, benchmark tests.
- **Benchmarks** — 5k run, push-ups, pull-ups, plank, burpees (2 min); best tested on day 1, 50 and 100. Shown publicly with change since the first test.
- **Private data** — mood, energy, weight, resting HR, notes and private photos only show when you're logged in.
- **Auto data** — Instagram + TikTok stats every 3 hours; Apple Health (steps, workouts, resting HR, weight) via an iOS Shortcut.
- **iPhone widget** — `widget/sweat100-widget.js` for the Scriptable app (home screen and lock screen).

Already created in your Cloudflare account: D1 database `sweat100` (tables + Day 1 entry) and R2 bucket `sweat100-photos`.

---

## 1. Deploy (about 5 minutes)

You need Node.js 20+.

```bash
cd 100-Days-of-Sweat
npm install
npx wrangler login                      # opens the browser, log in to Cloudflare
npx wrangler secret put ADMIN_TOKEN     # type a long password — this is your login
npm run db:migrate                      # applies database changes in migrations/ (safe to re-run)
npm run deploy
```

Wrangler prints your URL, e.g. `https://sweat100.<your-subdomain>.workers.dev`. Open `/log.html` on your iPhone, log in, then **Share → Add to Home Screen** so logging is one tap away.

After 10 wrong passwords from one IP in 15 minutes, logins from that IP are blocked for 15 minutes (devices already logged in keep working).

Whenever you pull a new version, run `npm run db:migrate` before `npm run deploy`.

Want a custom domain (e.g. `sweat.yourdomain.com`)? Cloudflare dashboard → Workers → sweat100 → Settings → Domains & Routes.

## 2. iPhone widget

1. Install **Scriptable** (free, App Store).
2. New script → paste `widget/sweat100-widget.js` → change `SITE` to your URL.
3. Long-press the home screen → **+** → Scriptable → Small or Medium → tap the widget → Script: *sweat100-widget*.
4. Lock screen: same, from the lock-screen widget gallery (circular or rectangular).

The widget shows day X/100, workout and Reel status, streak, and the medium size draws the 100-square sheet. It refreshes about every 30 minutes (iOS decides the exact timing).

## 3. Apple Health → tracker (iOS Shortcut)

Fitbit's old API switches off on 30 Oct 2026, and its replacement (Google Health API) requires a privacy/security review before it hands out data — not realistic for a personal project. On iPhone the reliable path is Apple Health. **If you haven't bought the tracker yet, pick one that writes workouts to Apple Health** (Apple Watch, Garmin, Oura, Whoop, Amazfit, Polar all do; Fitbit does not).

Build the shortcut once in the **Shortcuts** app:

1. **Find Health Samples** — Type *Steps*, Start Date *is today* → **Calculate Statistics** → *Sum* → set variable `steps`.
2. **Find Workouts** — Start Date *is today* → **Get Details of Workouts** → *Duration* → **Calculate Statistics** → *Sum* → set variable `workout` (check with *Show Result* whether it comes out in minutes; if it's seconds, divide by 60).
3. **Find Health Samples** — Type *Resting Heart Rate*, Start Date *is today*, Sort by Start Date latest first, Limit 1 → **Get Details** → *Value* → variable `rhr`.
4. **Get Contents of URL**
   - URL: `https://YOUR-URL/api/ingest/health`
   - Method: **POST**
   - Headers: `Authorization` = `Bearer YOUR_ADMIN_TOKEN`
   - Request Body: **JSON** with `steps` (number) = `steps`, `workout_minutes` (number) = `workout`, `resting_hr` (number) = `rhr`

Then **Automation → + → Time of Day → 22:30, Daily → Run Immediately** → run this shortcut. If you logged a workout by hand, your entry wins; Health only fills empty fields. If you forget to log, a recorded workout still ticks the day.

Optional fields the endpoint accepts: `date` (YYYY-MM-DD, default today), `active_kcal`, `weight_kg`, `workouts` (list of `{type, minutes}`).

## 4. Instagram (auto views, likes, followers)

Requirement: your Instagram must be a **Professional account** (Creator is free — Instagram → Settings → Account type and tools).

1. Go to developers.facebook.com → **Create app** → use case *Manage messaging & content on Instagram* (Instagram API with Instagram login).
2. In **Instagram → API setup with Instagram login**: add the redirect URL `https://YOUR-URL/callback/instagram`.
3. **App roles → Roles → Instagram testers** → add your Instagram username, then accept the invite in Instagram (Settings → Website permissions / Apps and websites → Tester invites). In development mode the app works for your own account without app review.
4. Copy the **Instagram app ID** and **Instagram app secret** (not the Facebook app ID), then:

```bash
npx wrangler secret put IG_APP_ID
npx wrangler secret put IG_APP_SECRET
```

5. On `/log.html` → Connected accounts → **Connect** Instagram. Tokens refresh automatically (60-day token, renewed when 10 days remain).

## 5. TikTok (auto views, likes, followers)

1. developers.tiktok.com → **Manage apps → Create app**. Add products **Login Kit** and the scopes `user.info.basic`, `user.info.stats`, `video.list`.
2. Redirect URI: `https://YOUR-URL/callback/tiktok`. Terms and Privacy URLs: `https://YOUR-URL/privacy.html`.
3. Start in **Sandbox**, add your TikTok account as a target user. If sandbox doesn't return your real videos, submit the app for review (personal-use apps with this privacy page are a common case; it takes a few days).
4. Then:

```bash
npx wrangler secret put TIKTOK_CLIENT_KEY
npx wrangler secret put TIKTOK_CLIENT_SECRET
```

5. `/log.html` → **Connect** TikTok.

After connecting, any post published since the challenge start appears on its day (the Reel dot in the sheet ticks automatically).

---

## Free-tier fit

Workers (100k requests/day), D1 (5 GB), R2 (10 GB, no egress fees) and the 3-hourly cron are all inside Cloudflare's free tier for this use. Photos are resized to 2048 px on the phone before upload (≈300–600 KB each), so 100 days of photos is well under 1 GB.

## API reference

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/summary` | public | Widget data: day, streak, today status, totals |
| GET | `/api/days` | public (more fields when logged in) | All 100 days + content per day + follower history |
| POST | `/api/days` | ✓ | Create/update a day (only sent fields change) |
| POST | `/api/ingest/health` | ✓ | Apple Health data from the Shortcut |
| GET / POST | `/api/photos` | GET public, POST ✓ | List / upload photos (`file`, `date`, `caption`, `public`) |
| PATCH / DELETE | `/api/photos/:id` | ✓ | Toggle public / delete |
| POST | `/api/sync` | ✓ | Sync Instagram + TikTok now |
| GET | `/api/status` | ✓ | Connection status + sync log |
| GET / POST | `/api/benchmarks` | GET public, POST ✓ | List / add a test result (`date`, `test`, `value` — seconds for times, count for reps) |
| DELETE | `/api/benchmarks/:id` | ✓ | Delete a test result |
| GET | `/api/export` | ✓ | Full JSON backup |

Auth = `Authorization: Bearer <ADMIN_TOKEN>` or the login cookie. Wrong Bearer tokens count towards the login lockout.

## Local development

```bash
echo 'ADMIN_TOKEN=dev' > .dev.vars
npm run db:local
npm run dev      # http://localhost:8787
```

## Files

```
src/index.js      routes, days, summary, photos, health ingest
src/sync.js       Instagram + TikTok OAuth and sync
src/util.js       helpers (dates in Europe/Madrid, auth)
public/           dashboard, log page, styles, icons, manifest
widget/           Scriptable widget for iPhone
schema.sql        D1 tables (full schema for a fresh database)
migrations/       changes to the live database, applied with `npm run db:migrate`
wrangler.jsonc    Cloudflare config (D1, R2, cron)
```
