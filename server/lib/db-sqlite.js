const { randomUUID } = require("crypto");
const fs = require("fs");
const path = require("path");

function createSqliteDb(filePath) {
  const Database = require("better-sqlite3");
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const db = Database(filePath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS friend_requests (
      id TEXT PRIMARY KEY,
      from_user TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      to_user TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_friend_req_pair ON friend_requests(from_user, to_user, status);
    CREATE TABLE IF NOT EXISTS friendships (
      user_low TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      user_high TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      PRIMARY KEY (user_low, user_high),
      CHECK (user_low < user_high)
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      user_low TEXT NOT NULL,
      user_high TEXT NOT NULL,
      sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      body TEXT NOT NULL,
      created_ms INTEGER NOT NULL,
      read_by_recipient INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(user_low, user_high, created_ms);
  `);
  const msgCols = db.prepare(`PRAGMA table_info(messages)`).all();
  if (!msgCols.some((c) => c.name === "read_by_recipient")) {
    db.exec(`ALTER TABLE messages ADD COLUMN read_by_recipient INTEGER NOT NULL DEFAULT 0;`);
  }

  async function findUserByUsername(username) {
    return (
      db
        .prepare(`SELECT id, username, password_hash, display_name, created_at FROM users WHERE username = ?`)
        .get(username) || null
    );
  }

  async function findUserById(id) {
    return (
      db.prepare(`SELECT id, username, password_hash, display_name, created_at FROM users WHERE id = ?`).get(id) ||
      null
    );
  }

  async function createUser({ username, password_hash, display_name }) {
    const id = randomUUID();
    const created_at = new Date().toISOString();
    db.prepare(
      `INSERT INTO users (id, username, password_hash, display_name, created_at) VALUES (?, ?, ?, ?, ?)`
    ).run(id, username, password_hash, display_name, created_at);
    return { id, username, password_hash, display_name, created_at };
  }

  async function createFriendRequest(from_user, to_user) {
    const row = db
      .prepare(
        `SELECT id, from_user, to_user, status, created_at FROM friend_requests
         WHERE from_user = ? AND to_user = ? AND status = 'pending'`
      )
      .get(from_user, to_user);
    if (row) return row;
    const id = randomUUID();
    const created_at = new Date().toISOString();
    db.prepare(
      `INSERT INTO friend_requests (id, from_user, to_user, status, created_at) VALUES (?, ?, ?, 'pending', ?)`
    ).run(id, from_user, to_user, created_at);
    return { id, from_user, to_user, status: "pending", created_at };
  }

  async function findPendingReverse(from_user, to_user) {
    return (
      db
        .prepare(
          `SELECT id, from_user, to_user, status FROM friend_requests
           WHERE from_user = ? AND to_user = ? AND status = 'pending'`
        )
        .get(to_user, from_user) || null
    );
  }

  async function markRequestAccepted(id) {
    db.prepare(`UPDATE friend_requests SET status = 'accepted' WHERE id = ?`).run(id);
  }

  async function markRequestRejected(id) {
    db.prepare(`UPDATE friend_requests SET status = 'rejected' WHERE id = ?`).run(id);
  }

  async function findRequestById(id) {
    return db.prepare(`SELECT id, from_user, to_user, status FROM friend_requests WHERE id = ?`).get(id) || null;
  }

  async function addFriendship(a, b) {
    const [user_low, user_high] = [a, b].sort();
    const created_at = new Date().toISOString();
    db.prepare(`INSERT OR IGNORE INTO friendships (user_low, user_high, created_at) VALUES (?, ?, ?)`).run(
      user_low,
      user_high,
      created_at
    );
  }

  async function areFriends(a, b) {
    const [user_low, user_high] = [a, b].sort();
    return !!db.prepare(`SELECT 1 FROM friendships WHERE user_low = ? AND user_high = ?`).get(user_low, user_high);
  }

  async function listIncomingRequests(userId) {
    return db
      .prepare(
        `SELECT r.id, r.from_user AS from_user, u.username AS from_username, u.display_name AS from_display_name, r.created_at
         FROM friend_requests r JOIN users u ON u.id = r.from_user
         WHERE r.to_user = ? AND r.status = 'pending' ORDER BY r.created_at DESC`
      )
      .all(userId);
  }

  async function listFriends(userId) {
    return db
      .prepare(
        `SELECT u.id, u.username, u.display_name FROM friendships f
         JOIN users u ON u.id = CASE WHEN f.user_low = ? THEN f.user_high ELSE f.user_low END
         WHERE f.user_low = ? OR f.user_high = ?
         ORDER BY u.username`
      )
      .all(userId, userId, userId);
  }

  async function insertMessage({ user_low, user_high, sender_id, body }) {
    const [lo, hi] = [user_low, user_high].sort();
    const id = randomUUID();
    const created_ms = Date.now();
    db.prepare(
      `INSERT INTO messages (id, user_low, user_high, sender_id, body, created_ms, read_by_recipient) VALUES (?, ?, ?, ?, ?, ?, 0)`
    ).run(id, lo, hi, sender_id, body, created_ms);
    return { id, sender_id, body, ts: created_ms };
  }

  async function listMessages(user_low, user_high, limit = 100) {
    const [lo, hi] = [user_low, user_high].sort();
    const rows = db
      .prepare(
        `SELECT id, sender_id, body, created_ms as ts, read_by_recipient FROM messages
         WHERE user_low = ? AND user_high = ? ORDER BY created_ms ASC LIMIT ?`
      )
      .all(lo, hi, limit);
    return rows.map((r) => ({
      id: r.id,
      sender_id: r.sender_id,
      body: r.body,
      ts: r.ts,
      read_by_recipient: !!r.read_by_recipient,
    }));
  }

  async function markMessagesRead(reader_id, peer_id) {
    const [lo, hi] = [reader_id, peer_id].sort();
    const r = db
      .prepare(
        `UPDATE messages
         SET read_by_recipient = 1
         WHERE user_low = ? AND user_high = ? AND sender_id = ? AND read_by_recipient = 0`
      )
      .run(lo, hi, peer_id);
    return r.changes || 0;
  }

  async function getUnreadCounts(userId) {
    const rows = db
      .prepare(
        `SELECT sender_id, COUNT(*) as unread
         FROM messages
         WHERE (user_low = ? OR user_high = ?)
           AND sender_id != ?
           AND read_by_recipient = 0
         GROUP BY sender_id`
      )
      .all(userId, userId, userId);
    const out = {};
    for (const r of rows) out[r.sender_id] = Number(r.unread || 0);
    return out;
  }

  return {
    mode: "sqlite",
    filePath,
    findUserByUsername,
    findUserById,
    createUser,
    createFriendRequest,
    findPendingReverse,
    markRequestAccepted,
    markRequestRejected,
    findRequestById,
    addFriendship,
    areFriends,
    listIncomingRequests,
    listFriends,
    insertMessage,
    listMessages,
    markMessagesRead,
    getUnreadCounts,
  };
}

module.exports = { createSqliteDb };
