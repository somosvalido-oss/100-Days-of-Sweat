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

/** True when the request carries the admin token (Bearer header or session cookie) */
export function isAuthed(request, env) {
  if (!env.ADMIN_TOKEN) return false;
  const h = request.headers.get("authorization") || "";
  const bearer = h.startsWith("Bearer ") ? h.slice(7).trim() : null;
  return safeEqual(bearer, env.ADMIN_TOKEN) || safeEqual(getCookie(request, "s100"), env.ADMIN_TOKEN);
}

export const sessionCookie = (token, maxAge = 60 * 60 * 24 * 180) =>
  `s100=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

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
