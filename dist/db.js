import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
const DATA_DIR = join(homedir(), ".rock-mcp");
if (!existsSync(DATA_DIR))
    mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = join(DATA_DIR, "docs.db");
export const db = new Database(DB_PATH);
// Enable WAL for better concurrent read performance
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(`
  CREATE TABLE IF NOT EXISTS sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT NOT NULL UNIQUE,
    title TEXT,
    description TEXT,
    added_at INTEGER NOT NULL,
    last_crawled_at INTEGER,
    crawl_depth INTEGER DEFAULT 2,
    max_pages INTEGER DEFAULT 50,
    status TEXT DEFAULT 'pending'
  );

  CREATE TABLE IF NOT EXISTS pages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    url TEXT NOT NULL UNIQUE,
    title TEXT,
    content TEXT NOT NULL,
    summary TEXT,
    topics TEXT,
    crawled_at INTEGER NOT NULL,
    content_hash TEXT NOT NULL,
    parent_url TEXT,
    depth INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS topic_index (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    topic TEXT NOT NULL,
    relevance REAL DEFAULT 1.0
  );

  CREATE INDEX IF NOT EXISTS idx_pages_source ON pages(source_id);
  CREATE INDEX IF NOT EXISTS idx_pages_url ON pages(url);
  CREATE INDEX IF NOT EXISTS idx_topic_index_topic ON topic_index(topic);

  -- FTS5 virtual table for fast full-text search
  CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(
    title,
    content,
    summary,
    topics,
    content='pages',
    content_rowid='id'
  );

  -- Triggers to keep FTS in sync with pages
  CREATE TRIGGER IF NOT EXISTS pages_ai AFTER INSERT ON pages BEGIN
    INSERT INTO pages_fts(rowid, title, content, summary, topics)
    VALUES (new.id, new.title, new.content, new.summary, new.topics);
  END;

  CREATE TRIGGER IF NOT EXISTS pages_ad AFTER DELETE ON pages BEGIN
    INSERT INTO pages_fts(pages_fts, rowid, title, content, summary, topics)
    VALUES ('delete', old.id, old.title, old.content, old.summary, old.topics);
  END;

  CREATE TRIGGER IF NOT EXISTS pages_au AFTER UPDATE ON pages BEGIN
    INSERT INTO pages_fts(pages_fts, rowid, title, content, summary, topics)
    VALUES ('delete', old.id, old.title, old.content, old.summary, old.topics);
    INSERT INTO pages_fts(rowid, title, content, summary, topics)
    VALUES (new.id, new.title, new.content, new.summary, new.topics);
  END;
`);
// --- Migrations ---
// v0.2: add max_pages column
const sourceCols = db.pragma("table_info(sources)").map((c) => c.name);
if (!sourceCols.includes("max_pages")) {
    db.exec("ALTER TABLE sources ADD COLUMN max_pages INTEGER DEFAULT 50");
}
// v0.3: rebuild FTS5 index if out of sync with pages table
// Happens when upgrading from a DB that pre-dates the FTS5 triggers
{
    const pageCount = db.prepare("SELECT COUNT(*) as c FROM pages").get().c;
    const ftsCount = db.prepare("SELECT COUNT(*) as c FROM pages_fts").get().c;
    if (pageCount > 0 && ftsCount !== pageCount) {
        db.exec(`
      INSERT INTO pages_fts(pages_fts) VALUES('rebuild');
    `);
    }
}
export const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours
//# sourceMappingURL=db.js.map