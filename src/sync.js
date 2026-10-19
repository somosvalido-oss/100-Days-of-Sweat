// Instagram, TikTok + Google Health (Fitbit): OAuth connection and sync
import { localDate, dayNumber, dateForDay } from "./util.js";
import { applyHealth } from "./health.js";

const now = () => Math.floor(Date.now() / 1000);

async function log(env, platform, ok, message) {
  await env.DB.prepare("INSERT INTO sync_log (platform, ok, message) VALUES (?, ?, ?)")
    .bind(platform, ok ? 1 : 0, String(message).slice(0, 500)).run();
  await env.DB.prepare("DELETE FROM sync_log WHERE id NOT IN (SELECT id FROM sync_log ORDER BY id DESC LIMIT 200)").run();
}

const getToken = (env, platform) =>
  env.DB.prepare("SELECT * FROM oauth_tokens WHERE platform = ?").bind(platform).first();

async function saveToken(env, platform, t) {
  await env.DB.prepare(
    `INSERT INTO oauth_tokens (platform, access_token, refresh_token, user_id, expires_at, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(platform) DO UPDATE SET access_token=excluded.access_token,
       refresh_token=COALESCE(excluded.refresh_token, oauth_tokens.refresh_token),
       user_id=COALESCE(excluded.user_id, oauth_tokens.user_id),
       expires_at=excluded.expires_at, updated_at=datetime('now')`
  ).bind(platform, t.access_token, t.refresh_token ?? null, t.user_id ?? null, t.expires_at ?? null).run();
}

// ---------- OAuth start / callback ----------

export async function startOAuth(platform, env, origin) {
  const state = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO oauth_state (state, platform, created_at) VALUES (?, ?, ?)")
    .bind(state, platform, now()).run();
  await env.DB.prepare("DELETE FROM oauth_state WHERE created_at < ?").bind(now() - 3600).run();
  const redirect = `${origin}/callback/${platform}`;

  if (platform === "instagram") {
    if (!env.IG_APP_ID) throw new Error("IG_APP_ID secret is not set");
    const u = new URL("https://www.instagram.com/oauth/authorize");
    u.searchParams.set("client_id", env.IG_APP_ID);
    u.searchParams.set("redirect_uri", redirect);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("scope", "instagram_business_basic,instagram_business_manage_insights");
    u.searchParams.set("state", state);
    return u.toString();
  }
  if (platform === "tiktok") {
    if (!env.TIKTOK_CLIENT_KEY) throw new Error("TIKTOK_CLIENT_KEY secret is not set");
    const u = new URL("https://www.tiktok.com/v2/auth/authorize/");
    u.searchParams.set("client_key", env.TIKTOK_CLIENT_KEY);
    u.searchParams.set("redirect_uri", redirect);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("scope", "user.info.basic,user.info.stats,video.list");
    u.searchParams.set("state", state);
    return u.toString();
  }
  if (platform === "google_health") {
    if (!env.GOOGLE_CLIENT_ID) throw new Error("GOOGLE_CLIENT_ID secret is not set");
    const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    u.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
    u.searchParams.set("redirect_uri", redirect);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("scope", GOOGLE_SCOPES);
    u.searchParams.set("access_type", "offline"); // refresh token for the cron
    u.searchParams.set("prompt", "consent");      // Google only returns a refresh token on consent
    u.searchParams.set("state", state);
    return u.toString();
  }
  throw new Error("Unknown platform");
}

export async function finishOAuth(platform, env, url) {
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  if (!state || !code) throw new Error(url.searchParams.get("error_description") || "Missing code");
  const row = await env.DB.prepare("SELECT * FROM oauth_state WHERE state = ? AND platform = ?").bind(state, platform).first();
  if (!row || row.created_at < now() - 3600) throw new Error("Invalid or expired state — try connecting again");
  await env.DB.prepare("DELETE FROM oauth_state WHERE state = ?").bind(state).run();
  const redirect = `${url.origin}/callback/${platform}`;

  if (platform === "instagram") {
    const form = new URLSearchParams({
      client_id: env.IG_APP_ID, client_secret: env.IG_APP_SECRET,
      grant_type: "authorization_code", redirect_uri: redirect, code: code.replace(/#_$/, ""),
    });
    const r = await fetch("https://api.instagram.com/oauth/access_token", { method: "POST", body: form });
    const short = await r.json();
    if (!r.ok || !short.access_token) throw new Error("Instagram token error: " + JSON.stringify(short));
    const lr = await fetch(
      `https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=${encodeURIComponent(env.IG_APP_SECRET)}&access_token=${encodeURIComponent(short.access_token)}`
    );
    const long = await lr.json();
    if (!lr.ok || !long.access_token) throw new Error("Instagram long-lived token error: " + JSON.stringify(long));
    await saveToken(env, "instagram", {
      access_token: long.access_token, user_id: String(short.user_id ?? ""),
      expires_at: now() + (long.expires_in || 5184000),
    });
  } else if (platform === "tiktok") {
    const form = new URLSearchParams({
      client_key: env.TIKTOK_CLIENT_KEY, client_secret: env.TIKTOK_CLIENT_SECRET,
      code, grant_type: "authorization_code", redirect_uri: redirect,
    });
    const r = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form,
    });
    const t = await r.json();
    if (!r.ok || !t.access_token) throw new Error("TikTok token error: " + JSON.stringify(t));
    await saveToken(env, "tiktok", {
      access_token: t.access_token, refresh_token: t.refresh_token,
      user_id: t.open_id, expires_at: now() + (t.expires_in || 86400),
    });
  } else if (platform === "google_health") {
    const t = await googleToken(env, { grant_type: "authorization_code", code, redirect_uri: redirect });
    if (!t.refresh_token) throw new Error("Google sent no refresh token — remove the app at myaccount.google.com/permissions and connect again");
    await saveToken(env, "google_health", t);
  } else {
    throw new Error("Unknown platform");
  }
  await log(env, platform, true, "Connected");
}

/** Forgets a connection. Google tokens are also revoked so the app loses access on Google's side. */
export async function disconnect(platform, env) {
  const tok = await getToken(env, platform);
  if (!tok) return;
  if (platform === "google_health") {
    await fetch("https://oauth2.googleapis.com/revoke", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: tok.refresh_token || tok.access_token }),
    }).catch(() => {});
  }
  await env.DB.prepare("DELETE FROM oauth_tokens WHERE platform = ?").bind(platform).run();
  await log(env, platform, true, "Disconnected");
}

// ---------- Sync ----------

async function upsertPost(env, p) {
  await env.DB.prepare(
    `INSERT INTO posts (platform, post_id, url, caption, media_type, posted_at, posted_date, views, likes, comments, shares, saves, reach, synced_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, datetime('now'))
     ON CONFLICT(platform, post_id) DO UPDATE SET url=excluded.url, caption=excluded.caption, media_type=excluded.media_type,
       views=COALESCE(excluded.views, posts.views), likes=COALESCE(excluded.likes, posts.likes),
       comments=COALESCE(excluded.comments, posts.comments), shares=COALESCE(excluded.shares, posts.shares),
       saves=COALESCE(excluded.saves, posts.saves), reach=COALESCE(excluded.reach, posts.reach),
       synced_at=excluded.synced_at`
  ).bind(p.platform, p.post_id, p.url, p.caption, p.media_type, p.posted_at, p.posted_date,
    p.views ?? null, p.likes ?? null, p.comments ?? null, p.shares ?? null, p.saves ?? null, p.reach ?? null).run();
}

async function snapshot(env, platform, followers, totalLikes, mediaCount) {
  await env.DB.prepare(
    `INSERT INTO follower_snapshots (platform, date, followers, total_likes, media_count) VALUES (?,?,?,?,?)
     ON CONFLICT(platform, date) DO UPDATE SET followers=excluded.followers, total_likes=excluded.total_likes, media_count=excluded.media_count`
  ).bind(platform, localDate(env), followers ?? null, totalLikes ?? null, mediaCount ?? null).run();
}

async function syncInstagram(env) {
  let tok = await getToken(env, "instagram");
  if (!tok) return "not connected";
  const v = env.IG_API_VERSION || "v23.0";
  const G = `https://graph.instagram.com/${v}`;

  // Long-lived tokens last 60 days; refresh when < 10 days remain
  if (tok.expires_at && tok.expires_at - now() < 10 * 86400) {
    const r = await fetch(`https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(tok.access_token)}`);
    const j = await r.json();
    if (r.ok && j.access_token) {
      await saveToken(env, "instagram", { access_token: j.access_token, expires_at: now() + (j.expires_in || 5184000) });
      tok = await getToken(env, "instagram");
    }
  }
  const at = encodeURIComponent(tok.access_token);

  const me = await (await fetch(`${G}/me?fields=followers_count,media_count&access_token=${at}`)).json();
  if (me.error) throw new Error(me.error.message);
  await snapshot(env, "instagram", me.followers_count, null, me.media_count);

  // Media posted since the challenge started
  const startMs = Date.parse(env.START_DATE + "T00:00:00Z") - 86400000;
  let next = `${G}/me/media?fields=id,caption,media_type,media_product_type,permalink,timestamp,like_count,comments_count&limit=50&access_token=${at}`;
  let pages = 0, count = 0;
  while (next && pages < 4) {
    const j = await (await fetch(next)).json();
    if (j.error) throw new Error(j.error.message);
    let older = false;
    for (const m of j.data || []) {
      const t = Date.parse(m.timestamp);
      if (t < startMs) { older = true; continue; }
      await upsertPost(env, {
        platform: "instagram", post_id: m.id, url: m.permalink, caption: (m.caption || "").slice(0, 300),
        media_type: m.media_product_type || m.media_type, posted_at: m.timestamp,
        posted_date: localDate(env, new Date(t)), likes: m.like_count, comments: m.comments_count,
      });
      count++;
    }
    next = older ? null : j.paging?.next;
    pages++;
  }

  // Insights (views, reach, shares, saves) — limited per run to respect subrequest limits
  const { results } = await env.DB.prepare(
    "SELECT post_id FROM posts WHERE platform='instagram' ORDER BY (views IS NULL) DESC, synced_at ASC LIMIT 25"
  ).all();
  for (const { post_id } of results) {
    const j = await (await fetch(`${G}/${post_id}/insights?metric=views,reach,shares,saved&access_token=${at}`)).json();
    if (j.error) continue;
    const val = (name) => j.data?.find((d) => d.name === name)?.values?.[0]?.value ?? null;
    await env.DB.prepare(
      "UPDATE posts SET views=COALESCE(?,views), reach=COALESCE(?,reach), shares=COALESCE(?,shares), saves=COALESCE(?,saves), synced_at=datetime('now') WHERE platform='instagram' AND post_id=?"
    ).bind(val("views"), val("reach"), val("shares"), val("saved"), post_id).run();
  }
  return `${count} posts, ${results.length} insights`;
}

async function syncTikTok(env) {
  let tok = await getToken(env, "tiktok");
  if (!tok) return "not connected";

  // Access tokens last 24h; refresh tokens 365 days
  if (!tok.expires_at || tok.expires_at - now() < 600) {
    const form = new URLSearchParams({
      client_key: env.TIKTOK_CLIENT_KEY, client_secret: env.TIKTOK_CLIENT_SECRET,
      grant_type: "refresh_token", refresh_token: tok.refresh_token,
    });
    const r = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form,
    });
    const t = await r.json();
    if (!r.ok || !t.access_token) throw new Error("TikTok refresh failed: " + JSON.stringify(t).slice(0, 200));
    await saveToken(env, "tiktok", { access_token: t.access_token, refresh_token: t.refresh_token, expires_at: now() + (t.expires_in || 86400) });
    tok = await getToken(env, "tiktok");
  }
  const auth = { authorization: `Bearer ${tok.access_token}` };

  const u = await (await fetch("https://open.tiktokapis.com/v2/user/info/?fields=follower_count,likes_count,video_count", { headers: auth })).json();
  if (u.error && u.error.code !== "ok") throw new Error(u.error.message || u.error.code);
  const user = u.data?.user || {};
  await snapshot(env, "tiktok", user.follower_count, user.likes_count, user.video_count);

  const startSec = Date.parse(env.START_DATE + "T00:00:00Z") / 1000 - 86400;
  const fields = "id,title,video_description,create_time,share_url,view_count,like_count,comment_count,share_count";
  let cursor, more = true, pages = 0, count = 0;
  while (more && pages < 8) {
    const r = await fetch(`https://open.tiktokapis.com/v2/video/list/?fields=${fields}`, {
      method: "POST", headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify(cursor ? { max_count: 20, cursor } : { max_count: 20 }),
    });
    const j = await r.json();
    if (j.error && j.error.code !== "ok") throw new Error(j.error.message || j.error.code);
    let older = false;
    for (const vdo of j.data?.videos || []) {
      if (vdo.create_time < startSec) { older = true; continue; }
      await upsertPost(env, {
        platform: "tiktok", post_id: vdo.id, url: vdo.share_url,
        caption: (vdo.title || vdo.video_description || "").slice(0, 300), media_type: "VIDEO",
        posted_at: new Date(vdo.create_time * 1000).toISOString(),
        posted_date: localDate(env, new Date(vdo.create_time * 1000)),
        views: vdo.view_count, likes: vdo.like_count, comments: vdo.comment_count, shares: vdo.share_count,
      });
      count++;
    }
    more = !older && j.data?.has_more;
    cursor = j.data?.cursor;
    pages++;
  }
  return `${count} videos`;
}

// ---------- Google Health (Fitbit, Pixel Watch) ----------

const GH = "https://health.googleapis.com/v4/users/me/dataTypes";
const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly",        // steps, exercise, calories
  "https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly", // resting heart rate
].join(" ");
const GH_DAYS = 7; // re-read the last week each run so late watch syncs and edits land

async function googleToken(env, params) {
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, ...params }),
  });
  const t = await r.json();
  if (!r.ok || !t.access_token) {
    if (t.error === "invalid_grant") throw new Error("Google access expired or was revoked — reconnect Google Health");
    throw new Error("Google token error: " + JSON.stringify(t).slice(0, 200));
  }
  return { access_token: t.access_token, refresh_token: t.refresh_token, expires_at: now() + (t.expires_in || 3600) };
}

const ymd = (d) => `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
const civil = (s) => ({ date: { year: +s.slice(0, 4), month: +s.slice(5, 7), day: +s.slice(8, 10) } });

async function ghFetch(auth, path, body) {
  const r = await fetch(`${GH}/${path}`, body
    ? { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(body) }
    : { headers: auth });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${path.split("?")[0]}: ${j.error?.message || r.status}`);
  return j;
}

async function syncGoogleHealth(env) {
  let tok = await getToken(env, "google_health");
  if (!tok) return "not connected";
  // Access tokens last 1 h; refresh tokens don't expire while the consent screen is "In production"
  if (!tok.expires_at || tok.expires_at - now() < 300) {
    await saveToken(env, "google_health", await googleToken(env, { grant_type: "refresh_token", refresh_token: tok.refresh_token }));
    tok = await getToken(env, "google_health");
  }
  const auth = { authorization: `Bearer ${tok.access_token}` };

  // Local dates [from, to) — the last GH_DAYS days, not before the challenge start
  const today = dayNumber(env, localDate(env));
  if (today < 1) return "challenge not started";
  const first = Math.max(1, today - GH_DAYS + 1);
  const from = dateForDay(env, first), to = dateForDay(env, today + 1);
  const days = {};
  const day = (d) => (days[d] ??= {});

  const range = { range: { start: civil(from), end: civil(to) }, windowSizeDays: 1 };
  for (const p of (await ghFetch(auth, "steps/dataPoints:dailyRollUp", range)).rollupDataPoints || []) {
    if (p.steps?.countSum != null) day(ymd(p.civilStartTime.date)).steps = Number(p.steps.countSum);
  }
  for (const p of (await ghFetch(auth, "active-energy-burned/dataPoints:dailyRollUp", range)).rollupDataPoints || []) {
    if (p.activeEnergyBurned?.kcalSum != null) day(ymd(p.civilStartTime.date)).active_kcal = p.activeEnergyBurned.kcalSum;
  }

  const rhr = await ghFetch(auth, "daily-resting-heart-rate/dataPoints?pageSize=100&filter=" +
    encodeURIComponent(`daily_resting_heart_rate.date >= "${from}" AND daily_resting_heart_rate.date < "${to}"`));
  for (const p of rhr.dataPoints || []) {
    const v = p.dailyRestingHeartRate;
    if (v?.date && v.beatsPerMinute) day(ymd(v.date)).resting_hr = Number(v.beatsPerMinute);
  }

  // Exercise sessions (max 25 per page). Auto-detected sessions (e.g. SmartTrack walks) are skipped so
  // that walking around doesn't tick the day — only workouts started on the watch or logged in the app count.
  let pageToken = "", pages = 0, sessions = 0;
  const filter = encodeURIComponent(`exercise.interval.civil_start_time >= "${from}" AND exercise.interval.civil_start_time < "${to}"`);
  do {
    const j = await ghFetch(auth, `exercise/dataPoints?pageSize=25&filter=${filter}${pageToken ? "&pageToken=" + encodeURIComponent(pageToken) : ""}`);
    for (const p of j.dataPoints || []) {
      const e = p.exercise;
      if (!e?.interval?.civilStartTime) continue;
      if (["PASSIVELY_MEASURED", "DERIVED"].includes(p.dataSource?.recordingMethod)) continue;
      const secs = e.activeDuration ? parseFloat(e.activeDuration)
        : (Date.parse(e.interval.endTime) - Date.parse(e.interval.startTime)) / 1000;
      const minutes = Math.round(secs / 60);
      if (!(minutes > 0)) continue;
      (day(ymd(e.interval.civilStartTime.date)).workouts ??= []).push({ type: e.displayName || e.exerciseType, minutes });
      sessions++;
    }
    pageToken = j.nextPageToken;
  } while (pageToken && ++pages < 4);

  let n = 0;
  for (const [date, d] of Object.entries(days)) {
    const dn = dayNumber(env, date);
    if (dn < 1) continue;
    // Oldest first, so the day's first workout names the activity
    d.workouts?.reverse();
    await applyHealth(env, date, dn, d);
    n++;
  }
  return `${n} days, ${sessions} workouts`;
}

export async function syncAll(env) {
  const out = {};
  for (const [name, fn] of [["instagram", syncInstagram], ["tiktok", syncTikTok], ["google_health", syncGoogleHealth]]) {
    try {
      out[name] = await fn(env);
      if (out[name] !== "not connected") await log(env, name, true, out[name]);
    } catch (e) {
      out[name] = "error: " + e.message;
      await log(env, name, false, e.message);
    }
  }
  return out;
}
