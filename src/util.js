// Shared helpers

export const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });

export const err = (message, status = 400) => json({ error: message }, status);

/** YYYY-MM-DD for a Date in the configured time zone */
export function localDate(env, d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: env.TZ || "Europe/Madrid",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d);
}

const toUTC = (s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));

/** Day number (1-based) of a YYYY-MM-DD date in the challenge */
export function dayNumber(env, date) {
  return Math.round((toUTC(date) - toUTC(env.START_DATE)) / 86400000) + 1;
}

export function dateForDay(env, n) {
  return new Date(toUTC(env.START_DATE) + (n - 1) * 86400000).toISOString().slice(0, 10);
}

export const isDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

function getCookie(request, name) {
  const c = request.headers.get("cookie") || "";
  const m = c.match(new RegExp("(?:^|;\\s*)" + name + "=([^;]+)"));
  return m ? decodeURIComponent(m[1]) : null;
}

export function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const enc = new TextEncoder();
  const x = enc.encode(a), y = enc.encode(b);
  if (x.length !== y.length) return false;
  return crypto.subtle.timingSafeEqual(x, y);
}

// Brute-force guard: after MAX_FAILS wrong passwords from one IP in FAIL_WINDOW seconds, that IP is locked out
const MAX_FAILS = 10;
const FAIL_WINDOW = 15 * 60;
const clientIp = (request) => request.headers.get("cf-connecting-ip") || "local";

export async function isLocked(request, env) {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM auth_failures WHERE ip = ? AND at > ?")
    .bind(clientIp(request), Math.floor(Date.now() / 1000) - FAIL_WINDOW).first();
  return (row?.n || 0) >= MAX_FAILS;
}

export async function recordFailure(request, env) {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO auth_failures (ip, at) VALUES (?, ?)").bind(clientIp(request), now),
    env.DB.prepare("DELETE FROM auth_failures WHERE at < ?").bind(now - 86400),
  ]);
}

/**
 * Checks a password against ADMIN_TOKEN with the brute-force guard.
 * Returns "ok", "wrong" or "locked".
 */
export async function checkPassword(request, env, token) {
  if (!env.ADMIN_TOKEN || typeof token !== "string") return "wrong";
  if (await isLocked(request, env)) return "locked";
  if (safeEqual(token, env.ADMIN_TOKEN)) return "ok";
  await recordFailure(request, env);
  return "wrong";
}

/** Session cookie value: HMAC of a fixed label keyed by ADMIN_TOKEN, so the password itself never sits in the cookie */
export async function sessionValue(env) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.ADMIN_TOKEN),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("s100-session-v1"));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** True when the request carries the admin token (Bearer header) or a valid session cookie */
export async function isAuthed(request, env) {
  if (!env.ADMIN_TOKEN) return false;
  const h = request.headers.get("authorization") || "";
  if (h.startsWith("Bearer ")) return (await checkPassword(request, env, h.slice(7).trim())) === "ok";
  // A 256-bit HMAC can't be guessed, so wrong cookies (e.g. after a password change) are not counted as failures
  const cookie = getCookie(request, "s100");
  return !!cookie && safeEqual(cookie, await sessionValue(env));
}

export const sessionCookie = (value, maxAge = 60 * 60 * 24 * 180) =>
  `s100=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

export const intOrNull = (v, min, max) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return null;
  if (min !== undefined && n < min) return min;
  if (max !== undefined && n > max) return max;
  return n;
};

export const numOrNull = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
};

export const strOrNull = (v, max = 2000) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
};
