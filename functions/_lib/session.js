/**
 * Shared helpers for the password gate.
 * The password lives only on the server (env.SHELF_PASSWORD, default below).
 * A successful login sets an HttpOnly, signed cookie; /api/books requires it.
 */

export const DEFAULT_PASSWORD = "2201";
export const COOKIE_NAME = "shelf_session";
export const SESSION_DAYS = 30;

const enc = new TextEncoder();

export function getPassword(env) {
  return String(env.SHELF_PASSWORD || DEFAULT_PASSWORD);
}

function getSecret(env) {
  // Signing secret. Falls back to the password so no extra setup is needed.
  return String(env.SESSION_SECRET || getPassword(env)) + "|chat-bookshelf-v1";
}

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return toHex(new Uint8Array(sig));
}

function toHex(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
  return out;
}

// Constant-time string comparison
export function safeEqual(a, b) {
  a = String(a);
  b = String(b);
  let diff = a.length ^ b.length;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

export async function passwordMatches(env, attempt) {
  // Compare HMACs so timing doesn't depend on the password's contents
  const [a, b] = await Promise.all([
    hmac(getSecret(env), "pw:" + String(attempt)),
    hmac(getSecret(env), "pw:" + getPassword(env)),
  ]);
  return safeEqual(a, b);
}

export async function makeToken(env) {
  const exp = Date.now() + SESSION_DAYS * 86400000;
  const sig = await hmac(getSecret(env), "session:" + exp);
  return exp + "." + sig;
}

export async function verifyToken(env, token) {
  if (!token || typeof token !== "string") return false;
  const dot = token.indexOf(".");
  if (dot < 1) return false;
  const exp = Number(token.slice(0, dot));
  const sig = token.slice(dot + 1);
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  const expected = await hmac(getSecret(env), "session:" + exp);
  return safeEqual(sig, expected);
}

export function readCookie(request, name) {
  const header = request.headers.get("Cookie") || "";
  const parts = header.split(";");
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i].trim();
    if (p.startsWith(name + "=")) return decodeURIComponent(p.slice(name.length + 1));
  }
  return "";
}

export async function isAuthed(request, env) {
  return verifyToken(env, readCookie(request, COOKIE_NAME));
}

export function sessionCookie(request, token, clear) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  const age = clear ? 0 : SESSION_DAYS * 86400;
  return (
    COOKIE_NAME + "=" + (clear ? "" : encodeURIComponent(token)) +
    "; Path=/; HttpOnly; SameSite=Lax; Max-Age=" + age + secure
  );
}

export function json(data, status, extraHeaders) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign(
      { "Content-Type": "application/json", "Cache-Control": "no-store" },
      extraHeaders || {}
    ),
  });
}
