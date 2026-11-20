# Chat's Bookshelf

Static site + Cloudflare Pages Functions + D1 (SQLite). No build step.
Live at: https://chatreads.pages.dev

## Deploy (Cloudflare Pages)
1. Put this folder in a Git repo and connect it to the Pages project (or run `npx wrangler pages deploy .`).
   Build command: none. Output directory: `/` (project root).
   Note: dashboard drag-and-drop uploads do not run the `functions/` folder.
2. Create a D1 database (Workers & Pages > D1) and bind it to the Pages project:
   Settings > Bindings > D1 database > variable name **DB**. Redeploy.
   Tables are created automatically on first use (`schema.sql` is there if you prefer to do it by hand).
3. Password: defaults to **2201**. To change it without editing code, add an environment
   variable `SHELF_PASSWORD` in Pages settings. Optionally add `SESSION_SECRET` (any long random string).

## What changed vs. the original
- Password is checked on the server; the API requires a signed login cookie (30 days). Wrong guesses are rate-limited per IP (5 tries, then 45s).
- Sync is local-first with an offline queue and retry; edits merge by `updatedAt`; deletions now sync correctly; notes autosave.
- Shelf lays out by measured width on every screen size; spines, shelf and 3D book redesigned.
- Self-hosted fonts, service worker (works offline), real installable PWA manifest and icons.
- Remove has an Undo toast. Keyboard accessible. Press `/` to focus search.

## Files
index.html, styles.css, app.js, sw.js, manifest.webmanifest, _headers, fonts/, icons/,
functions/api/{auth,books,_middleware}.js, functions/_lib/session.js, schema.sql
