import Database from 'better-sqlite3';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';

// Ensure data directory exists
const dataDir = dirname(config.sqlite.path);
if (!existsSync(dataDir)) {
  mkdirSync(dataDir, { recursive: true });
}

const db = new Database(config.sqlite.path);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Schema ──
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender TEXT NOT NULL CHECK(sender IN ('user', 'bot')),
    content TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    context_token TEXT,
    analysis_delta TEXT,
    outreach INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS jiwen_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS rolling_summaries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    window_start_id INTEGER NOT NULL,
    window_end_id INTEGER NOT NULL,
    summary TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS memory_fragments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL CHECK(type IN ('fact', 'preference', 'emotion', 'event')),
    content TEXT NOT NULL,
    source_message_id INTEGER,
    confidence REAL DEFAULT 0.5,
    access_count INTEGER DEFAULT 0,
    last_accessed TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS extraction_cursor (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    last_processed_message_id INTEGER DEFAULT 0,
    last_summary_message_id INTEGER DEFAULT 0,
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
  CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender);
  CREATE INDEX IF NOT EXISTS idx_fragments_type ON memory_fragments(type);
  CREATE INDEX IF NOT EXISTS idx_fragments_accessed ON memory_fragments(last_accessed);
`);

// FTS5 virtual tables — drop and recreate to ensure correct schema
db.exec(`
  DROP TABLE IF EXISTS fragments_fts;
  DROP TABLE IF EXISTS messages_fts;
`);

db.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS fragments_fts USING fts5(
    content,
    content_rowid='id',
    tokenize='trigram'
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    content,
    sender,
    content_rowid='id',
    tokenize='trigram'
  );
`);

// Seed extraction_cursor if empty
db.exec(`
  INSERT OR IGNORE INTO extraction_cursor (id, last_processed_message_id, last_summary_message_id)
  VALUES (1, 0, 0);
`);

// ── Auto-populate FTS5 indexes from existing data on startup ──
db.exec(`
  INSERT OR IGNORE INTO messages_fts(rowid, content, sender)
  SELECT id, content, sender FROM messages
`);
db.exec(`
  INSERT OR IGNORE INTO fragments_fts(rowid, content)
  SELECT id, content FROM memory_fragments
`);

// ── Prepared statements ──
const insertMsg = db.prepare(`
  INSERT INTO messages (sender, content, timestamp, context_token, outreach)
  VALUES (@sender, @content, @timestamp, @context_token, @outreach)
`);

const getLastN = db.prepare(`
  SELECT sender, content, timestamp, context_token
  FROM messages
  ORDER BY id DESC
  LIMIT ?
`);

const getLastUser = db.prepare(`
  SELECT id, content, timestamp
  FROM messages
  WHERE sender = 'user'
  ORDER BY id DESC
  LIMIT 1
`);

const countOutreach24h = db.prepare(`
  SELECT COUNT(*) AS cnt
  FROM messages
  WHERE sender = 'bot' AND outreach = 1
    AND created_at > datetime('now', '-1 day')
`);

const loadState = db.prepare(`
  SELECT key, value FROM jiwen_state
`);

const upsertState = db.prepare(`
  INSERT INTO jiwen_state (key, value) VALUES (@key, @value)
  ON CONFLICT(key) DO UPDATE SET value = @value
`);

// ── Memory: fragments ──
const stmtInsertFragment = db.prepare(`
  INSERT INTO memory_fragments (type, content, source_message_id, confidence)
  VALUES (@type, @content, @source_message_id, @confidence)
`);

const stmtSearchFragmentsFTS = db.prepare(`
  SELECT f.id, f.type, f.content, f.confidence, f.access_count,
         fts.rank AS _rank
  FROM fragments_fts fts
  JOIN memory_fragments f ON fts.rowid = f.id
  WHERE fragments_fts MATCH @query
  ORDER BY fts.rank
  LIMIT @limit
`);

const stmtSearchFragmentsLike = db.prepare(`
  SELECT id, type, content, confidence, access_count, 999 AS _rank
  FROM memory_fragments
  WHERE content LIKE @likeQuery
  ORDER BY id DESC
  LIMIT @limit
`);

const stmtTouchFragment = db.prepare(`
  UPDATE memory_fragments
  SET access_count = access_count + 1,
      last_accessed = datetime('now')
  WHERE id = @id
`);

// ── Memory: messages FTS ──
const stmtSearchMessagesFTS = db.prepare(`
  SELECT m.id, m.sender, m.content, m.timestamp,
         fts.rank AS _rank
  FROM messages_fts fts
  JOIN messages m ON fts.rowid = m.id
  WHERE messages_fts MATCH @query
  ORDER BY fts.rank
  LIMIT @limit
`);

// ── Memory: summaries ──
const stmtInsertSummary = db.prepare(`
  INSERT INTO rolling_summaries (window_start_id, window_end_id, summary)
  VALUES (@window_start_id, @window_end_id, @summary)
`);

const stmtGetLatestSummaries = db.prepare(`
  SELECT summary FROM rolling_summaries
  ORDER BY id DESC
  LIMIT @limit
`);

// ── Memory: extraction cursor ──
const stmtGetCursor = db.prepare(`
  SELECT last_processed_message_id, last_summary_message_id
  FROM extraction_cursor WHERE id = 1
`);

const stmtUpdateCursor = db.prepare(`
  UPDATE extraction_cursor
  SET last_processed_message_id = @last_processed,
      last_summary_message_id = @last_summary,
      updated_at = datetime('now')
  WHERE id = 1
`);

// ── Memory: message range for extraction ──
const stmtGetMessagesSince = db.prepare(`
  SELECT id, sender, content, timestamp
  FROM messages
  WHERE id > @since_id
  ORDER BY id ASC
`);

const stmtGetMessageCountSince = db.prepare(`
  SELECT COUNT(*) AS cnt FROM messages
  WHERE id > @since_id AND sender = 'user'
`);

const stmtGetMaxMessageId = db.prepare(`
  SELECT COALESCE(MAX(id), 0) AS max_id FROM messages
`);

// ── FTS5 sync (keep FTS indexes in sync when inserting into base tables) ──
const stmtSyncMessageFTS = db.prepare(`
  INSERT INTO messages_fts(rowid, content, sender)
  VALUES (@id, @content, @sender)
`);

const stmtSyncFragmentFTS = db.prepare(`
  INSERT INTO fragments_fts(rowid, content)
  VALUES (@id, @content)
`);

// ── Public API ──

export function insertMessage(sender, content, timestamp, contextToken = null, outreach = 0) {
  const result = insertMsg.run({ sender, content, timestamp, context_token: contextToken, outreach });
  stmtSyncMessageFTS.run({ id: result.lastInsertRowid, content, sender });
  return result;
}

export function getLastNMessages(n = 4) {
  // Returns chronological order (oldest first)
  return getLastN.all(n).reverse();
}

export function getLastUserMessage() {
  return getLastUser.get() || null;
}

export function getOutreachCount24h() {
  const row = countOutreach24h.get();
  return row ? row.cnt : 0;
}

export function loadJiwenState() {
  const rows = loadState.all();
  if (rows.length === 0) return null;
  const obj = {};
  for (const row of rows) {
    try {
      obj[row.key] = JSON.parse(row.value);
    } catch {
      obj[row.key] = row.value;
    }
  }
  return obj;
}

export function saveJiwenState(stateObj) {
  const transaction = db.transaction((s) => {
    for (const [key, value] of Object.entries(s)) {
      upsertState.run({ key, value: JSON.stringify(value) });
    }
  });
  transaction(stateObj);
}

// ── Memory public API ──

export function insertFragment(type, content, sourceMessageId = null, confidence = 0.5) {
  const result = stmtInsertFragment.run({ type, content, source_message_id: sourceMessageId, confidence });
  stmtSyncFragmentFTS.run({ id: result.lastInsertRowid, content });
  return result;
}

export function searchFragments(query, limit = 20) {
  const safeQuery = query.replace(/['"*]/g, '').replace(/\s+/g, ' ').trim();
  if (!safeQuery) return [];

  // FTS5 trigram: query must be at least 3 chars for trigram matching
  let results = [];
  if (safeQuery.length >= 3) {
    results = stmtSearchFragmentsFTS.all({ query: safeQuery, limit });
  }

  // LIKE fallback: catch short keywords (< 3 chars) and supplement FTS misses
  const likeQuery = `%${safeQuery}%`;
  const likeResults = stmtSearchFragmentsLike.all({ likeQuery, limit });
  const ftsIds = new Set(results.map((r) => r.id));
  for (const r of likeResults) {
    if (!ftsIds.has(r.id)) results.push(r);
  }

  return results.slice(0, limit);
}

export function touchFragments(ids) {
  for (const id of ids) {
    stmtTouchFragment.run({ id });
  }
}

export function searchMessages(query, limit = 10) {
  const safeQuery = query.replace(/['"*]/g, '').replace(/\s+/g, ' ').trim();
  if (!safeQuery) return [];
  // FTS5 trigram: full query is always long enough (user messages are sentences)
  return stmtSearchMessagesFTS.all({ query: safeQuery, limit });
}

export function insertSummary(windowStartId, windowEndId, summary) {
  return stmtInsertSummary.run({ window_start_id: windowStartId, window_end_id: windowEndId, summary });
}

export function getLatestSummaries(limit = 3) {
  return stmtGetLatestSummaries.all({ limit }).map(r => r.summary);
}

export function getExtractionCursor() {
  return stmtGetCursor.get() || { last_processed_message_id: 0, last_summary_message_id: 0 };
}

export function updateExtractionCursor(lastProcessed, lastSummary) {
  return stmtUpdateCursor.run({ last_processed: lastProcessed, last_summary: lastSummary });
}

export function getUnprocessedMessages(sinceId) {
  return stmtGetMessagesSince.all({ since_id: sinceId });
}

export function getNewMessageCountSince(sinceId) {
  const row = stmtGetMessageCountSince.get({ since_id: sinceId });
  return row ? row.cnt : 0;
}

export function getMaxMessageIdValue() {
  return stmtGetMaxMessageId.get().max_id;
}

export function syncMessageToFTS(id, content, sender) {
  stmtSyncMessageFTS.run({ id, content, sender });
}

export function closeDb() {
  db.close();
}
