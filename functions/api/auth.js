/**
 * Chat's Bookshelf – password gate
 *   GET    /api/auth   -> { authed: boolean }
 *   POST   /api/auth   -> { password }  sets the session cookie
 *   DELETE /api/auth   -> clears the session cookie
 *
 * Wrong guesses are rate-limited per IP (5 tries, then a 45s lock) using the
 * D1 database, so the limit can't be dodged by clearing browser storage.
 */
import {
  isAuthed, passwordMatches, makeToken, sessionCookie, json,
} from "../_lib/session.js";

const MAX_ATTEMPTS = 5;
const LOCK_SECONDS = 45;

export async function onRequest(context) {
  const { request, env } = context;
  const method = request.method;

  if (method === "GET") {
    return json({ authed: await isAuthed(request, env) });
  }

  if (method === "DELETE") {
    return json({ ok: true }, 200, { "Set-Cookie": sessionCookie(request, "", true) });
  }

  if (method !== "POST") return json({ error: "Method not allowed" }, 405);

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const db = env.DB || null;
  const now = Date.now();

  // ---- lock check ----
  const row = await readAttempts(db, ip);
  if (row && row.lockUntil > now) {
    return json(
      { ok: false, locked: true, retryAfter: Math.ceil((row.lockUntil - now) / 1000) },
      429
    );
  }

  let body = {};
  try { body = await request.json(); } catch (e) {}
  const attempt = typeof body.password === "string" ? body.password.trim() : "";

  if (attempt && (await passwordMatches(env, attempt))) {
    await clearAttempts(db, ip);
    const token = await makeToken(env);
    return json({ ok: true }, 200, { "Set-Cookie": sessionCookie(request, token, false) });
  }

  // ---- wrong password ----
  await new Promise((r) => setTimeout(r, 350)); // slow down guessing a little
  const count = ((row && row.count) || 0) + 1;
  if (count >= MAX_ATTEMPTS) {
    await writeAttempts(db, ip, 0, now + LOCK_SECONDS * 1000);
    return json({ ok: false, locked: true, retryAfter: LOCK_SECONDS }, 429);
  }
  await writeAttempts(db, ip, count, 0);
  return json({ ok: false, attempts: count, max: MAX_ATTEMPTS }, 401);
}

// ---------- attempt tracking (best effort: never blocks login if D1 is missing) ----------
let tableReady = null;
function ensureTable(db) {
  if (!tableReady) {
    tableReady = db
      .prepare(
        "CREATE TABLE IF NOT EXISTS auth_attempts (ip TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0, lockUntil INTEGER NOT NULL DEFAULT 0)"
      )
      .run()
      .catch((e) => { tableReady = null; throw e; });
  }
  return tableReady;
}

async function readAttempts(db, ip) {
  if (!db) return null;
  try {
    await ensureTable(db);
    return await db.prepare("SELECT count, lockUntil FROM auth_attempts WHERE ip = ?").bind(ip).first();
  } catch (e) { return null; }
}
async function writeAttempts(db, ip, count, lockUntil) {
  if (!db) return;
  try {
    await ensureTable(db);
    await db
      .prepare(
        "INSERT INTO auth_attempts (ip, count, lockUntil) VALUES (?, ?, ?) ON CONFLICT(ip) DO UPDATE SET count = excluded.count, lockUntil = excluded.lockUntil"
      )
      .bind(ip, count, lockUntil)
      .run();
  } catch (e) {}
}
async function clearAttempts(db, ip) {
  if (!db) return;
  try {
    await ensureTable(db);
    await db.prepare("DELETE FROM auth_attempts WHERE ip = ?").bind(ip).run();
  } catch (e) {}
}
