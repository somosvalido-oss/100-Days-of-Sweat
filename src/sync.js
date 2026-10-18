// Instagram + TikTok: OAuth connection and stats sync
import { localDate } from "./util.js";

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
  }
  await log(env, platform, true, "Connected");
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

export async function syncAll(env) {
  const out = {};
  for (const [name, fn] of [["instagram", syncInstagram], ["tiktok", syncTikTok]]) {
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
