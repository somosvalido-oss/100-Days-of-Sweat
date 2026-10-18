// 100 Days of Sweat — Cloudflare Worker (API + static site)
import {
  json, err, localDate, dayNumber, dateForDay, isDate, isAuthed, checkPassword,
  sessionCookie, sessionValue, intOrNull, numOrNull, strOrNull,
} from "./util.js";
import { startOAuth, finishOAuth, syncAll } from "./sync.js";

const DONE_SQL = `(COALESCE(minutes,0) > 0 OR (activity IS NOT NULL AND activity <> '') OR COALESCE(health_workout_minutes,0) > 0)`;
const PUBLIC_DAY_FIELDS = ["date", "day_number", "activity", "minutes", "intensity", "reel_done", "reel_url", "steps", "health_workout_minutes"];
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", "image/gif"];
const MAX_PHOTO_BYTES = 20 * 1024 * 1024;
// Benchmark tests: "time" values are stored in seconds, "reps" as a count. lower = smaller is better.
export const BENCHMARKS = {
  run_5k:  { label: "5k run",        kind: "time", lower: true },
  pushups: { label: "Push-ups",      kind: "reps" },
  pullups: { label: "Pull-ups",      kind: "reps" },
  plank:   { label: "Plank",         kind: "time" },
  burpees: { label: "Burpees (2 min)", kind: "reps" },
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const p = url.pathname;
    try {
      if (p.startsWith("/api/")) return await api(request, env, ctx, url);
      if (p.startsWith("/photo/")) return await servePhoto(request, env, p.slice(7));
      if (p.startsWith("/connect/")) {
        if (!(await isAuthed(request, env))) return Response.redirect(`${url.origin}/log.html`, 302);
        return Response.redirect(await startOAuth(p.slice(9), env, url.origin), 302);
      }
      if (p.startsWith("/callback/")) {
        try {
          await finishOAuth(p.slice(10), env, url);
          ctx.waitUntil(syncAll(env));
          return Response.redirect(`${url.origin}/log.html?connected=${p.slice(10)}`, 302);
        } catch (e) {
          return Response.redirect(`${url.origin}/log.html?oauth_error=${encodeURIComponent(e.message)}`, 302);
        }
      }
      if (p === "/") return await dashboardPage(request, env, url);
      return env.ASSETS ? env.ASSETS.fetch(request) : new Response("Not found", { status: 404 });
    } catch (e) {
      console.error(e);
      return err("Server error: " + e.message, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(syncAll(env));
  },
};

async function api(request, env, ctx, url) {
  const p = url.pathname.replace(/\/+$/, "");
  const m = request.method;
  const authed = await isAuthed(request, env);
  const need = () => (authed ? null : err("Unauthorized", 401));

  // ---- auth ----
  if (p === "/api/login" && m === "POST") {
    const { token } = await request.json().catch(() => ({}));
    if (!env.ADMIN_TOKEN) return err("ADMIN_TOKEN secret is not set on the Worker", 500);
    const result = await checkPassword(request, env, token);
    if (result === "locked") return err("Too many wrong passwords — try again in 15 minutes", 429);
    if (result !== "ok") return err("Wrong password", 401);
    return json({ ok: true }, 200, { "set-cookie": sessionCookie(await sessionValue(env)) });
  }
  if (p === "/api/logout" && m === "POST") return json({ ok: true }, 200, { "set-cookie": sessionCookie("", 0) });
  if (p === "/api/me") return json({ authed });

  // ---- read ----
  if (p === "/api/summary" && m === "GET") return json(await summary(env, authed), 200, { "access-control-allow-origin": "*" });
  if (p === "/api/days" && m === "GET") return json(await allDays(env, authed));

  // ---- write a day ----
  if (p === "/api/days" && (m === "POST" || m === "PUT")) {
    const r = need(); if (r) return r;
    const body = await request.json().catch(() => null);
    if (!body) return err("JSON body required");
    const date = body.date || localDate(env);
    if (!isDate(date)) return err("date must be YYYY-MM-DD");
    const n = dayNumber(env, date);
    if (n < 1 || n > Number(env.TOTAL_DAYS) + 7) return err(`Date is outside the challenge (day ${n})`);
    await upsertDay(env, date, n, body);
    return json(await env.DB.prepare("SELECT * FROM days WHERE date=?").bind(date).first());
  }

  // ---- Apple Health ingest (iOS Shortcut) ----
  if (p === "/api/ingest/health" && m === "POST") {
    const r = need(); if (r) return r;
    const b = await request.json().catch(() => null);
    if (!b) return err("JSON body required");
    const date = isDate(b.date) ? b.date : localDate(env);
    const n = dayNumber(env, date);
    if (n < 1) return err("Before challenge start");
    const workouts = Array.isArray(b.workouts) ? b.workouts.slice(0, 20) : null;
    const wMin = intOrNull(b.workout_minutes ?? workouts?.reduce((s, w) => s + (Number(w.minutes) || 0), 0), 0, 1440);
    const firstType = strOrNull(workouts?.[0]?.type, 60) ?? strOrNull(b.workout_type, 60);
    await env.DB.prepare("INSERT OR IGNORE INTO days (date, day_number) VALUES (?, ?)").bind(date, n).run();
    await env.DB.prepare(
      `UPDATE days SET
         steps = COALESCE(?, steps),
         active_kcal = COALESCE(?, active_kcal),
         health_workout_minutes = COALESCE(?, health_workout_minutes),
         health_workouts = COALESCE(?, health_workouts),
         resting_hr = COALESCE(resting_hr, ?),
         weight_kg = COALESCE(weight_kg, ?),
         activity = CASE WHEN (activity IS NULL OR activity='') AND ? > 0 THEN ? ELSE activity END,
         minutes = CASE WHEN minutes IS NULL AND ? > 0 THEN ? ELSE minutes END,
         updated_at = datetime('now')
       WHERE date = ?`
    ).bind(
      intOrNull(b.steps, 0), intOrNull(b.active_kcal, 0), wMin,
      workouts ? JSON.stringify(workouts) : null,
      intOrNull(b.resting_hr, 25, 220), numOrNull(b.weight_kg),
      wMin || 0, firstType || "Workout", wMin || 0, wMin, date
    ).run();
    return json({ ok: true, date, day: n });
  }

  // ---- photos ----
  if (p === "/api/photos" && m === "GET") {
    const date = url.searchParams.get("date");
    let sql = "SELECT id, date, caption, is_public, created_at FROM photos";
    const where = [], binds = [];
    if (!authed) where.push("is_public = 1");
    if (isDate(date)) { where.push("date = ?"); binds.push(date); }
    if (where.length) sql += " WHERE " + where.join(" AND ");
    sql += " ORDER BY date DESC, created_at DESC LIMIT 500";
    const { results } = await env.DB.prepare(sql).bind(...binds).all();
    return json(results.map((x) => ({ ...x, url: `/photo/${x.id}` })));
  }
  if (p === "/api/photos" && m === "POST") {
    const r = need(); if (r) return r;
    const form = await request.formData();
    const file = form.get("file");
    if (!file || typeof file === "string") return err("file is required");
    if (!IMAGE_TYPES.includes(file.type)) return err("Only images are allowed (" + file.type + ")");
    if (file.size > MAX_PHOTO_BYTES) return err("Photo too large (max 20 MB)");
    const date = isDate(form.get("date")) ? form.get("date") : localDate(env);
    const id = crypto.randomUUID();
    const ext = (file.type.split("/")[1] || "jpg").replace("jpeg", "jpg");
    const key = `${date}/${id}.${ext}`;
    await env.PHOTOS.put(key, file.stream(), { httpMetadata: { contentType: file.type } });
    await env.DB.prepare("INSERT OR IGNORE INTO days (date, day_number) VALUES (?, ?)").bind(date, dayNumber(env, date)).run();
    await env.DB.prepare("INSERT INTO photos (id, date, r2_key, content_type, caption, is_public) VALUES (?,?,?,?,?,?)")
      .bind(id, date, key, file.type, strOrNull(form.get("caption"), 300), form.get("public") === "1" ? 1 : 0).run();
    return json({ ok: true, id, url: `/photo/${id}` });
  }
  const pm = p.match(/^\/api\/photos\/([0-9a-f-]{36})$/);
  if (pm && (m === "DELETE" || m === "PATCH")) {
    const r = need(); if (r) return r;
    const row = await env.DB.prepare("SELECT * FROM photos WHERE id=?").bind(pm[1]).first();
    if (!row) return err("Not found", 404);
    if (m === "DELETE") {
      await env.PHOTOS.delete(row.r2_key);
      await env.DB.prepare("DELETE FROM photos WHERE id=?").bind(row.id).run();
      return json({ ok: true });
    }
    const b = await request.json().catch(() => ({}));
    await env.DB.prepare("UPDATE photos SET is_public = COALESCE(?, is_public), caption = COALESCE(?, caption) WHERE id=?")
      .bind(b.public === undefined ? null : b.public ? 1 : 0, strOrNull(b.caption, 300), row.id).run();
    return json({ ok: true });
  }

  // ---- benchmarks ----
  if (p === "/api/benchmarks" && m === "GET") {
    const { results } = await env.DB.prepare("SELECT id, date, test, value FROM benchmarks ORDER BY date, id").all();
    return json({ tests: BENCHMARKS, results: results.map((x) => ({ ...x, day_number: dayNumber(env, x.date) })) });
  }
  if (p === "/api/benchmarks" && m === "POST") {
    const r = need(); if (r) return r;
    const b = await request.json().catch(() => null);
    if (!b) return err("JSON body required");
    if (!BENCHMARKS[b.test]) return err("Unknown test");
    const date = b.date || localDate(env);
    if (!isDate(date)) return err("date must be YYYY-MM-DD");
    const value = numOrNull(b.value);
    if (value === null || value <= 0 || value > 100000) return err("value must be a positive number");
    const row = await env.DB.prepare("INSERT INTO benchmarks (date, test, value) VALUES (?, ?, ?) RETURNING id, date, test, value")
      .bind(date, b.test, value).first();
    return json(row);
  }
  const bm = p.match(/^\/api\/benchmarks\/(\d+)$/);
  if (bm && m === "DELETE") {
    const r = need(); if (r) return r;
    await env.DB.prepare("DELETE FROM benchmarks WHERE id = ?").bind(+bm[1]).run();
    return json({ ok: true });
  }

  // ---- integrations ----
  if (p === "/api/sync" && m === "POST") {
    const r = need(); if (r) return r;
    return json(await syncAll(env));
  }
  if (p === "/api/status" && m === "GET") {
    const r = need(); if (r) return r;
    const { results: tokens } = await env.DB.prepare("SELECT platform, user_id, expires_at, updated_at FROM oauth_tokens").all();
    const { results: logs } = await env.DB.prepare("SELECT * FROM sync_log ORDER BY id DESC LIMIT 15").all();
    return json({
      configured: { instagram: !!(env.IG_APP_ID && env.IG_APP_SECRET), tiktok: !!(env.TIKTOK_CLIENT_KEY && env.TIKTOK_CLIENT_SECRET) },
      connected: Object.fromEntries(tokens.map((t) => [t.platform, t])),
      logs,
    });
  }
  if (p === "/api/export" && m === "GET") {
    const r = need(); if (r) return r;
    const q = (t) => env.DB.prepare(`SELECT * FROM ${t}`).all().then((x) => x.results);
    return json({ exported_at: new Date().toISOString(), days: await q("days"), posts: await q("posts"),
      follower_snapshots: await q("follower_snapshots"), photos: await q("photos"), benchmarks: await q("benchmarks") }, 200,
      { "content-disposition": `attachment; filename="sweat100-${localDate(env)}.json"` });
  }

  return err("Not found", 404);
}

async function upsertDay(env, date, n, b) {
  const fields = {
    activity: strOrNull(b.activity, 120),
    minutes: intOrNull(b.minutes, 0, 1440),
    intensity: intOrNull(b.intensity, 1, 5),
    mood: intOrNull(b.mood, 1, 5),
    energy: intOrNull(b.energy, 1, 5),
    weight_kg: numOrNull(b.weight_kg),
    resting_hr: intOrNull(b.resting_hr, 25, 220),
    reel_done: b.reel_done === undefined ? null : b.reel_done ? 1 : 0,
    reel_url: strOrNull(b.reel_url, 500),
    notes: strOrNull(b.notes, 4000),
  };
  // Only update keys that were sent; an explicit empty value clears the field
  const keys = Object.keys(fields).filter((k) => k in b);
  await env.DB.prepare("INSERT OR IGNORE INTO days (date, day_number) VALUES (?, ?)").bind(date, n).run();
  if (keys.length) {
    await env.DB.prepare(`UPDATE days SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = datetime('now') WHERE date = ?`)
      .bind(...keys.map((k) => fields[k]), date).run();
  }
}

async function allDays(env, authed) {
  const today = localDate(env);
  const todayN = dayNumber(env, today);
  const total = Number(env.TOTAL_DAYS);
  const [{ results: rows }, { results: postAgg }, { results: photoAgg }] = await Promise.all([
    env.DB.prepare(`SELECT *, ${DONE_SQL} AS done FROM days ORDER BY date`).all(),
    env.DB.prepare(`SELECT posted_date AS date, platform, COUNT(*) AS posts, SUM(COALESCE(views,0)) AS views,
                    SUM(COALESCE(likes,0)) AS likes FROM posts GROUP BY posted_date, platform`).all(),
    env.DB.prepare(`SELECT date, COUNT(*) AS n FROM photos ${authed ? "" : "WHERE is_public=1"} GROUP BY date`).all(),
  ]);
  const byDate = Object.fromEntries(rows.map((r) => [r.date, r]));
  const posts = {};
  for (const a of postAgg) (posts[a.date] ||= {})[a.platform] = { posts: a.posts, views: a.views, likes: a.likes };
  const photos = Object.fromEntries(photoAgg.map((x) => [x.date, x.n]));

  const days = [];
  for (let n = 1; n <= total; n++) {
    const date = dateForDay(env, n);
    const row = byDate[date] || {};
    const base = authed ? { ...row } : Object.fromEntries(PUBLIC_DAY_FIELDS.map((k) => [k, row[k] ?? null]));
    delete base.done;
    const content = posts[date] || {};
    const reel = !!row.reel_done || Object.keys(content).length > 0;
    days.push({
      ...base, date, day_number: n,
      status: row.done ? "done" : n === todayN ? "today" : n < todayN ? "missed" : "future",
      reel, full: !!row.done && reel, content, photos: photos[date] || 0,
    });
  }
  const { results: followers } = await env.DB.prepare(
    "SELECT platform, date, followers FROM follower_snapshots ORDER BY date"
  ).all();
  return { start: env.START_DATE, total, today, today_n: todayN, authed, days, followers };
}

async function summary(env, authed) {
  const d = await allDays(env, authed);
  const past = d.days.filter((x) => x.day_number <= d.today_n);
  const done = past.filter((x) => x.status === "done");
  // Streak: consecutive done days ending today (or yesterday if today is still open)
  let streak = 0;
  for (let i = Math.min(d.today_n, d.total) - 1; i >= 0; i--) {
    const day = d.days[i];
    if (day.status === "done") streak++;
    else if (day.status === "today") continue;
    else break;
  }
  const { results: snaps } = await env.DB.prepare(
    `SELECT s.platform, s.followers, s.total_likes FROM follower_snapshots s
     JOIN (SELECT platform, MAX(date) AS md FROM follower_snapshots GROUP BY platform) t
     ON s.platform=t.platform AND s.date=t.md`
  ).all();
  const { results: firstSnaps } = await env.DB.prepare(
    `SELECT s.platform, s.followers FROM follower_snapshots s
     JOIN (SELECT platform, MIN(date) AS md FROM follower_snapshots GROUP BY platform) t
     ON s.platform=t.platform AND s.date=t.md`
  ).all();
  const { results: views } = await env.DB.prepare(
    "SELECT platform, COUNT(*) AS posts, SUM(COALESCE(views,0)) AS views, SUM(COALESCE(likes,0)) AS likes FROM posts GROUP BY platform"
  ).all();
  const todayRow = d.days.find((x) => x.day_number === d.today_n) || null;
  const out = {
    day: Math.max(0, Math.min(d.today_n, d.total)),
    total: d.total,
    today: d.today,
    started: d.today_n >= 1,
    finished: d.today_n > d.total,
    done_today: todayRow?.status === "done",
    reel_today: !!todayRow?.reel,
    today_activity: todayRow?.activity ?? null,
    today_minutes: todayRow?.minutes ?? todayRow?.health_workout_minutes ?? null,
    streak,
    days_done: done.length,
    full_days: done.filter((x) => x.full).length,
    days_missed: past.filter((x) => x.status === "missed").length,
    reels: past.filter((x) => x.reel).length,
    total_minutes: done.reduce((s, x) => s + (x.minutes || x.health_workout_minutes || 0), 0),
    content: Object.fromEntries(views.map((v) => [v.platform, {
      posts: v.posts, views: v.views, likes: v.likes,
      followers: snaps.find((s) => s.platform === v.platform)?.followers ?? null,
      followers_start: firstSnaps.find((s) => s.platform === v.platform)?.followers ?? null,
    }])),
    total_views: views.reduce((s, v) => s + (v.views || 0), 0),
  };
  if (authed) {
    const withMood = done.filter((x) => x.mood);
    out.avg_mood = withMood.length ? +(withMood.reduce((s, x) => s + x.mood, 0) / withMood.length).toFixed(1) : null;
    const w = past.filter((x) => x.weight_kg);
    out.weight_start = w[0]?.weight_kg ?? null;
    out.weight_latest = w.at(-1)?.weight_kg ?? null;
    const hr = past.filter((x) => x.resting_hr);
    out.rhr_start = hr[0]?.resting_hr ?? null;
    out.rhr_latest = hr.at(-1)?.resting_hr ?? null;
  }
  return out;
}

async function servePhoto(request, env, id) {
  if (!/^[0-9a-f-]{36}$/.test(id)) return new Response("Not found", { status: 404 });
  const row = await env.DB.prepare("SELECT * FROM photos WHERE id=?").bind(id).first();
  if (!row) return new Response("Not found", { status: 404 });
  if (!row.is_public && !(await isAuthed(request, env))) return new Response("Private photo", { status: 403 });
  const obj = await env.PHOTOS.get(row.r2_key);
  if (!obj) return new Response("Missing file", { status: 404 });
  return new Response(obj.body, {
    headers: {
      "content-type": row.content_type || "image/jpeg",
      "cache-control": row.is_public ? "public, max-age=86400" : "private, max-age=3600",
      etag: obj.httpEtag,
    },
  });
}

// Link previews (WhatsApp, iMessage, Instagram bio…) need an absolute og:image URL, so it is filled in per request
async function dashboardPage(request, env, url) {
  const res = await env.ASSETS.fetch(request);
  if (!res.ok || !(res.headers.get("content-type") || "").includes("text/html")) return res;
  return new HTMLRewriter()
    .on('meta[property="og:image"]', { element: (el) => el.setAttribute("content", `${url.origin}/og.png`) })
    .on('meta[property="og:url"]', { element: (el) => el.setAttribute("content", `${url.origin}/`) })
    .transform(res);
}
