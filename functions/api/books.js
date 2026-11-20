/**
 * Chat's Bookshelf – D1 API
 *   GET    /api/books            all books, newest first
 *   POST   /api/books            create or update one book (last write wins by updatedAt)
 *   DELETE /api/books?id=...     delete one book
 *
 * Auth is enforced by ./_middleware.js. The table is created automatically on
 * first use, and an `updatedAt` column is added to older databases.
 */
import { json } from "../_lib/session.js";

const STATUSES = ["want", "reading", "read"];
const COLOR_RE = /^(#[0-9a-fA-F]{3,8}|rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\))$/;

let schemaReady = null;
function ensureSchema(db) {
  if (!schemaReady) {
    schemaReady = (async () => {
      await db
        .prepare(
          `CREATE TABLE IF NOT EXISTS books (
            id TEXT PRIMARY KEY,
            workKey TEXT,
            title TEXT NOT NULL,
            author TEXT,
            year INTEGER,
            pages INTEGER,
            isbn TEXT,
            coverId TEXT,
            status TEXT NOT NULL DEFAULT 'want',
            rating INTEGER NOT NULL DEFAULT 0,
            note TEXT NOT NULL DEFAULT '',
            spineColor TEXT,
            accentColor TEXT,
            addedAt INTEGER NOT NULL DEFAULT 0,
            updatedAt INTEGER NOT NULL DEFAULT 0
          )`
        )
        .run();
      const info = await db.prepare("PRAGMA table_info(books)").all();
      const cols = (info.results || []).map((c) => c.name);
      if (cols.indexOf("updatedAt") === -1) {
        await db.prepare("ALTER TABLE books ADD COLUMN updatedAt INTEGER NOT NULL DEFAULT 0").run();
      }
    })().catch((e) => {
      schemaReady = null;
      throw e;
    });
  }
  return schemaReady;
}

export async function onRequest(context) {
  const { request, env } = context;
  const db = env.DB;
  if (!db) return json({ error: "D1 database not bound (expected binding name: DB)" }, 500);

  const method = request.method;
  const url = new URL(request.url);

  try {
    await ensureSchema(db);

    if (method === "GET") {
      const { results } = await db
        .prepare("SELECT * FROM books ORDER BY addedAt DESC")
        .all();
      return json(results || []);
    }

    if (method === "POST") {
      const text = await request.text();
      if (text.length > 20000) return json({ error: "Payload too large" }, 413);
      let body;
      try { body = JSON.parse(text); } catch (e) { return json({ error: "Invalid JSON" }, 400); }

      const book = sanitize(body);
      if (!book) return json({ error: "id and title are required" }, 400);

      // Only overwrite when the incoming version is at least as new as the stored one.
      await db
        .prepare(
          `INSERT INTO books (
            id, workKey, title, author, year, pages, isbn, coverId,
            status, rating, note, spineColor, accentColor, addedAt, updatedAt
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            workKey = excluded.workKey,
            title = excluded.title,
            author = excluded.author,
            year = excluded.year,
            pages = excluded.pages,
            isbn = excluded.isbn,
            coverId = excluded.coverId,
            status = excluded.status,
            rating = excluded.rating,
            note = excluded.note,
            spineColor = excluded.spineColor,
            accentColor = excluded.accentColor,
            addedAt = excluded.addedAt,
            updatedAt = excluded.updatedAt
          WHERE excluded.updatedAt >= books.updatedAt`
        )
        .bind(
          book.id, book.workKey, book.title, book.author, book.year, book.pages,
          book.isbn, book.coverId, book.status, book.rating, book.note,
          book.spineColor, book.accentColor, book.addedAt, book.updatedAt
        )
        .run();

      return json({ ok: true });
    }

    if (method === "DELETE") {
      const id = url.searchParams.get("id");
      if (!id) return json({ error: "id query parameter required" }, 400);
      await db.prepare("DELETE FROM books WHERE id = ?").bind(id).run();
      return json({ ok: true });
    }

    return json({ error: "Method not allowed" }, 405);
  } catch (err) {
    console.error("D1 error:", err);
    return json({ error: "Internal error" }, 500);
  }
}

// ---------- validation ----------
function str(v, max) {
  if (v === null || v === undefined) return null;
  return String(v).slice(0, max);
}
function int(v, min, max) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return n;
}

function sanitize(b) {
  if (!b || typeof b !== "object") return null;
  const id = str(b.id, 64);
  const title = str(b.title, 300);
  if (!id || !title) return null;

  const now = Date.now();
  return {
    id,
    workKey: str(b.workKey, 100),
    title,
    author: str(b.author, 300),
    year: int(b.year, 0, 3000),
    pages: int(b.pages, 0, 100000),
    isbn: str(b.isbn, 40),
    coverId: b.coverId ? str(b.coverId, 20) : null,
    status: STATUSES.indexOf(b.status) !== -1 ? b.status : "want",
    rating: int(b.rating, 0, 5) || 0,
    note: str(b.note, 5000) || "",
    spineColor: COLOR_RE.test(b.spineColor || "") ? b.spineColor : null,
    accentColor: COLOR_RE.test(b.accentColor || "") ? b.accentColor : null,
    addedAt: int(b.addedAt, 0, 9e15) || now,
    updatedAt: int(b.updatedAt, 0, 9e15) || now,
  };
}
