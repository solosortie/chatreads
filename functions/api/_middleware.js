/**
 * Runs before every /api/* route.
 *  - blocks cross-site writes (CSRF)
 *  - requires a valid session cookie for everything except /api/auth
 */
import { isAuthed, json } from "../_lib/session.js";

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);

  // Cross-site write protection: if the browser says where the request came
  // from, it must be this very site.
  if (request.method !== "GET" && request.method !== "HEAD") {
    const origin = request.headers.get("Origin");
    if (origin) {
      let host = "";
      try { host = new URL(origin).host; } catch (e) {}
      if (host !== url.host) return json({ error: "Forbidden" }, 403);
    }
  }

  if (url.pathname === "/api/auth" || url.pathname === "/api/auth/") {
    return next();
  }

  if (!(await isAuthed(request, env))) {
    return json({ error: "Unauthorized" }, 401);
  }
  return next();
}
