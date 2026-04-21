const { randomUUID } = require("crypto");

/** @typedef {{ id: string, username: string, password_hash: string, display_name: string, created_at: string }} UserRow */
/** @typedef {{ id: string, from_user: string, to_user: string, status: string, created_at: string }} ReqRow */
/** @typedef {{ user_low: string, user_high: string, created_at: string }} FriendRow */
/** @typedef {{ id: string, user_low: string, user_high: string, sender_id: string, body: string, created_at: string }} MsgRow */

function convKey(a, b) {
  return [a, b].sort().join(":");
}

function createMemoryDb() {
  /** @type {UserRow[]} */
  const users = [];
  /** @type {ReqRow[]} */
  const friendRequests = [];
  /** @type {Set<string>} */
  const friendships = new Set();
  /** @type {MsgRow[]} */
  const messages = [];

  async function findUserByUsername(username) {
    return users.find((u) => u.username === username) || null;
  }

  async function findUserById(id) {
    return users.find((u) => u.id === id) || null;
  }

  async function createUser({ username, password_hash, display_name }) {
    const row = {
      id: randomUUID(),
      username,
      password_hash,
      display_name,
      created_at: new Date().toISOString(),
    };
    users.push(row);
    return row;
  }

  async function createFriendRequest(from_user, to_user) {
    const dup = friendRequests.find(
      (r) =>
        r.from_user === from_user &&
        r.to_user === to_user &&
        r.status === "pending"
    );
    if (dup) return dup;
    const row = {
      id: randomUUID(),
      from_user,
      to_user,
      status: "pending",
      created_at: new Date().toISOString(),
    };
    friendRequests.push(row);
    return row;
  }

  async function findPendingReverse(from_user, to_user) {
    return (
      friendRequests.find(
        (r) =>
          r.from_user === to_user &&
          r.to_user === from_user &&
          r.status === "pending"
      ) || null
    );
  }

  async function markRequestAccepted(id) {
    const r = friendRequests.find((x) => x.id === id);
    if (r) r.status = "accepted";
  }

  async function markRequestRejected(id) {
    const r = friendRequests.find((x) => x.id === id);
    if (r) r.status = "rejected";
  }

  async function findRequestById(id) {
    return friendRequests.find((x) => x.id === id) || null;
  }

  async function addFriendship(a, b) {
    const k = convKey(a, b);
    const [low, high] = k.split(":");
    friendships.add(`${low}:${high}`);
  }

  async function areFriends(a, b) {
    return friendships.has(convKey(a, b));
  }

  async function listIncomingRequests(userId) {
    const rows = friendRequests.filter(
      (r) => r.to_user === userId && r.status === "pending"
    );
    const out = [];
    for (const r of rows) {
      const u = await findUserById(r.from_user);
      if (u)
        out.push({
          id: r.id,
          from_user: r.from_user,
          from_username: u.username,
          from_display_name: u.display_name,
          created_at: r.created_at,
        });
    }
    return out;
  }

  async function listFriends(userId) {
    const list = [];
    for (const key of friendships) {
      const [low, high] = key.split(":");
      let peer = null;
      if (low === userId) peer = high;
      else if (high === userId) peer = low;
      if (!peer) continue;
      const u = await findUserById(peer);
      if (u)
        list.push({
          id: u.id,
          username: u.username,
          display_name: u.display_name,
        });
    }
    return list.sort((a, b) => a.username.localeCompare(b.username));
  }

  async function insertMessage({ user_low, user_high, sender_id, body }) {
    const [lo, hi] = [user_low, user_high].sort();
    const row = {
      id: randomUUID(),
      user_low: lo,
      user_high: hi,
      sender_id,
      body,
      created_at: new Date().toISOString(),
    };
    messages.push(row);
    const ts = new Date(row.created_at).getTime();
    return { id: row.id, sender_id, body, ts };
  }

  async function listMessages(user_low, user_high, limit = 100) {
    const [lo, hi] = [user_low, user_high].sort();
    const arr = messages.filter((m) => m.user_low === lo && m.user_high === hi);
    return arr.slice(-limit).map((m) => ({
      id: m.id,
      sender_id: m.sender_id,
      body: m.body,
      ts: new Date(m.created_at).getTime(),
    }));
  }

  return {
    mode: "memory",
    findUserByUsername,
    findUserById,
    createUser,
    createFriendRequest,
    findPendingReverse,
    markRequestAccepted,
    markRequestRejected,
    addFriendship,
    areFriends,
    listIncomingRequests,
    listFriends,
    insertMessage,
    listMessages,
    findRequestById,
  };
}

function createPgDb(pool) {
  async function init() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        username VARCHAR(32) UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        display_name VARCHAR(64) NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS friend_requests (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        from_user UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        to_user UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        status VARCHAR(16) NOT NULL DEFAULT 'pending',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_friend_req_pair ON friend_requests(from_user, to_user, status);
      CREATE TABLE IF NOT EXISTS friendships (
        user_low UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        user_high UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (user_low, user_high),
        CHECK (user_low::text < user_high::text)
      );
      CREATE TABLE IF NOT EXISTS messages (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_low UUID NOT NULL,
        user_high UUID NOT NULL,
        sender_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        body TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(user_low, user_high, created_at);
    `);
  }

  async function findUserByUsername(username) {
    const { rows } = await pool.query(
      `SELECT id, username, password_hash, display_name, created_at::text FROM users WHERE username = $1`,
      [username]
    );
    return rows[0] || null;
  }

  async function findUserById(id) {
    const { rows } = await pool.query(
      `SELECT id, username, password_hash, display_name, created_at::text FROM users WHERE id = $1`,
      [id]
    );
    return rows[0] || null;
  }

  async function createUser({ username, password_hash, display_name }) {
    const { rows } = await pool.query(
      `INSERT INTO users (username, password_hash, display_name) VALUES ($1,$2,$3)
       RETURNING id, username, password_hash, display_name, created_at::text`,
      [username, password_hash, display_name]
    );
    return rows[0];
  }

  async function createFriendRequest(from_user, to_user) {
    const ex = await pool.query(
      `SELECT id, from_user::text, to_user::text, status, created_at::text FROM friend_requests
       WHERE from_user=$1 AND to_user=$2 AND status='pending'`,
      [from_user, to_user]
    );
    if (ex.rows[0]) return ex.rows[0];
    const { rows } = await pool.query(
      `INSERT INTO friend_requests (from_user, to_user) VALUES ($1,$2)
       RETURNING id, from_user::text, to_user::text, status, created_at::text`,
      [from_user, to_user]
    );
    return rows[0];
  }

  async function findPendingReverse(from_user, to_user) {
    const { rows } = await pool.query(
      `SELECT id, from_user::text, to_user::text, status FROM friend_requests
       WHERE from_user=$1 AND to_user=$2 AND status='pending'`,
      [to_user, from_user]
    );
    return rows[0] || null;
  }

  async function markRequestAccepted(id) {
    await pool.query(`UPDATE friend_requests SET status='accepted' WHERE id=$1`, [id]);
  }

  async function markRequestRejected(id) {
    await pool.query(`UPDATE friend_requests SET status='rejected' WHERE id=$1`, [id]);
  }

  async function findRequestById(id) {
    const { rows } = await pool.query(
      `SELECT id, from_user::text, to_user::text, status FROM friend_requests WHERE id=$1`,
      [id]
    );
    return rows[0] || null;
  }

  async function addFriendship(a, b) {
    const [user_low, user_high] = [a, b].sort();
    await pool.query(
      `INSERT INTO friendships (user_low, user_high) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [user_low, user_high]
    );
  }

  async function areFriends(a, b) {
    const [user_low, user_high] = [a, b].sort();
    const { rows } = await pool.query(
      `SELECT 1 FROM friendships WHERE user_low=$1 AND user_high=$2`,
      [user_low, user_high]
    );
    return rows.length > 0;
  }

  async function listIncomingRequests(userId) {
    const { rows } = await pool.query(
      `SELECT r.id, r.from_user::text AS from_user, u.username AS from_username, u.display_name AS from_display_name, r.created_at::text
       FROM friend_requests r JOIN users u ON u.id = r.from_user
       WHERE r.to_user = $1 AND r.status = 'pending' ORDER BY r.created_at DESC`,
      [userId]
    );
    return rows;
  }

  async function listFriends(userId) {
    const { rows } = await pool.query(
      `SELECT u.id::text, u.username, u.display_name FROM friendships f
       JOIN users u ON u.id = CASE WHEN f.user_low = $1::uuid THEN f.user_high ELSE f.user_low END
       WHERE f.user_low = $1::uuid OR f.user_high = $1::uuid
       ORDER BY u.username`,
      [userId]
    );
    return rows;
  }

  async function insertMessage({ user_low, user_high, sender_id, body }) {
    const [lo, hi] = [user_low, user_high].sort();
    const { rows } = await pool.query(
      `INSERT INTO messages (user_low, user_high, sender_id, body) VALUES ($1,$2,$3,$4)
       RETURNING id::text, user_low::text, user_high::text, sender_id::text, body, (extract(epoch from created_at)*1000)::bigint as ts`,
      [lo, hi, sender_id, body]
    );
    return rows[0];
  }

  async function listMessages(user_low, user_high, limit = 100) {
    const [lo, hi] = [user_low, user_high].sort();
    const { rows } = await pool.query(
      `SELECT id::text, sender_id::text, body, (extract(epoch from created_at)*1000)::bigint as ts
       FROM messages WHERE user_low=$1 AND user_high=$2 ORDER BY created_at ASC LIMIT $3`,
      [lo, hi, limit]
    );
    return rows;
  }

  return {
    mode: "postgres",
    init,
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
  };
}

function resolveMongoUri() {
  const explicit = process.env.MONGODB_URI || process.env.MONGO_URL;
  if (explicit) return explicit;
  const du = process.env.DATABASE_URL;
  if (du && (du.startsWith("mongodb://") || du.startsWith("mongodb+srv://"))) return du;
  return null;
}

function resolvePostgresUrl() {
  const du = process.env.DATABASE_URL;
  if (!du) return null;
  if (du.startsWith("postgres://") || du.startsWith("postgresql://")) return du;
  return null;
}

async function createDb() {
  const firebaseJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  const hasFirebaseFields =
    process.env.FIREBASE_PROJECT_ID &&
    process.env.FIREBASE_CLIENT_EMAIL &&
    process.env.FIREBASE_PRIVATE_KEY;
  if (firebaseJson || hasFirebaseFields) {
    try {
      const { createFirebaseDb } = require("./db-firebase");
      const db = await createFirebaseDb();
      console.log("[db] Firebase Firestore 已连接（账号、好友与聊天记录持久保存）");
      return db;
    } catch (e) {
      if (process.env.FIREBASE_STRICT === "1") throw e;
      console.warn(
        "[db] Firebase 不可用，自动回退到下一存储（MongoDB / PostgreSQL / SQLite）。",
        e && e.message
      );
    }
  }

  const mongoUri = resolveMongoUri();
  if (mongoUri) {
    try {
      const { createMongoDb } = require("./db-mongo");
      const db = await createMongoDb(mongoUri);
      console.log("[db] MongoDB 已连接（账号、好友与聊天记录持久保存）");
      return db;
    } catch (e) {
      if (process.env.MONGODB_STRICT === "1") throw e;
      console.warn(
        "[db] MongoDB 不可用，自动回退到下一存储（PostgreSQL / SQLite）。如需强制 Mongo 失败即退出，请设 MONGODB_STRICT=1。"
      );
    }
  }

  const pgUrl = resolvePostgresUrl();
  if (pgUrl) {
    const { Pool } = require("pg");
    const pool = new Pool({
      connectionString: pgUrl,
      ssl: pgUrl.includes("localhost") || pgUrl.includes("127.0.0.1") ? false : { rejectUnauthorized: false },
    });
    const db = createPgDb(pool);
    await db.init();
    console.log("[db] PostgreSQL 已连接并初始化表结构");
    return db;
  }

  if (process.env.USE_MEMORY_DB === "1") {
    console.warn("[db] USE_MEMORY_DB=1：内存模式，数据不持久化（仅调试）");
    return createMemoryDb();
  }

  const path = require("path");
  const sqlitePath =
    process.env.SQLITE_PATH || path.join(process.cwd(), "data", "wx.db");
  try {
    const { createSqliteDb } = require("./db-sqlite");
    const db = createSqliteDb(sqlitePath);
    console.log(`[db] SQLite 文件库：${sqlitePath}（账号与聊天记录持久保存）`);
    return db;
  } catch (e) {
    console.warn(
      "[db] SQLite 不可用（常见于未安装 better-sqlite3 原生模块），回退内存库：",
      e && e.message
    );
    return createMemoryDb();
  }
}

module.exports = { createDb, convKey };
