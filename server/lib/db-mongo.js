const { randomUUID } = require("crypto");
const { MongoClient } = require("mongodb");

/**
 * MongoDB 实现：与 PostgreSQL / SQLite 相同的数据访问接口。
 * 使用字符串 UUID 作为 _id，与 JWT、Socket 层一致。
 */
function mapUser(doc) {
  if (!doc) return null;
  const id = doc._id ?? doc.id;
  return {
    id,
    username: doc.username,
    password_hash: doc.password_hash,
    display_name: doc.display_name,
    created_at: doc.created_at,
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function buildMongoClientOptions() {
  const opts = {
    serverSelectionTimeoutMS: 25_000,
    connectTimeoutMS: 20_000,
    maxPoolSize: 10,
  };
  /** Render 等环境 IPv6 链路到 Atlas 时偶发 TLS alert 80，默认强制 IPv4 */
  if (process.env.MONGODB_PREFER_IPV6 !== "1") {
    opts.family = 4;
  }
  return opts;
}

async function createMongoDb(uri) {
  let client;
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    client = new MongoClient(uri, buildMongoClientOptions());
    try {
      await client.connect();
      lastErr = undefined;
      break;
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[db] MongoDB 连接尝试 ${attempt}/3 失败:`, msg);
      try {
        await client.close();
      } catch {
        /* ignore */
      }
      client = undefined;
      if (attempt < 3) await sleep(2500);
    }
  }
  if (!client && lastErr) {
    const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
    console.error(
      "[db] MongoDB 连接失败。请检查：1) MONGODB_URI 是否正确（密码特殊字符需 URL 编码）2) Atlas → Network Access 添加 0.0.0.0/0 或 Render 出口 IP 3) 用户名与 Database User 密码",
      "\n详情:",
      msg
    );
    throw lastErr;
  }

  const dbName = process.env.MONGODB_DB_NAME || "wxchat";
  const db = client.db(dbName);

  const users = db.collection("users");
  const friendRequests = db.collection("friend_requests");
  const friendships = db.collection("friendships");
  const messages = db.collection("messages");

  await users.createIndex({ username: 1 }, { unique: true });
  await friendRequests.createIndex({ from_user: 1, to_user: 1, status: 1 });
  await friendRequests.createIndex({ to_user: 1, status: 1 });
  await friendships.createIndex({ user_low: 1, user_high: 1 }, { unique: true });
  await messages.createIndex({ user_low: 1, user_high: 1, created_ms: 1 });

  async function findUserByUsername(username) {
    return mapUser(await users.findOne({ username }));
  }

  async function findUserById(id) {
    return mapUser(await users.findOne({ _id: id }));
  }

  async function createUser({ username, password_hash, display_name }) {
    const id = randomUUID();
    const created_at = new Date().toISOString();
    const doc = { _id: id, username, password_hash, display_name, created_at };
    await users.insertOne(doc);
    return { id: doc._id, username, password_hash, display_name, created_at };
  }

  async function createFriendRequest(from_user, to_user) {
    const existing = await friendRequests.findOne({
      from_user,
      to_user,
      status: "pending",
    });
    if (existing) {
      return {
        id: existing._id,
        from_user: existing.from_user,
        to_user: existing.to_user,
        status: existing.status,
        created_at: existing.created_at,
      };
    }
    const id = randomUUID();
    const created_at = new Date().toISOString();
    const doc = { _id: id, from_user, to_user, status: "pending", created_at };
    await friendRequests.insertOne(doc);
    return { id, from_user, to_user, status: "pending", created_at };
  }

  /** 对方发给我的待处理申请：DB.from = peer, DB.to = me */
  async function findPendingReverse(from_user, to_user) {
    const row = await friendRequests.findOne({
      from_user: to_user,
      to_user: from_user,
      status: "pending",
    });
    if (!row) return null;
    return { id: row._id, from_user: row.from_user, to_user: row.to_user, status: row.status };
  }

  async function markRequestAccepted(id) {
    await friendRequests.updateOne({ _id: id }, { $set: { status: "accepted" } });
  }

  async function markRequestRejected(id) {
    await friendRequests.updateOne({ _id: id }, { $set: { status: "rejected" } });
  }

  async function findRequestById(id) {
    const row = await friendRequests.findOne({ _id: id });
    if (!row) return null;
    return { id: row._id, from_user: row.from_user, to_user: row.to_user, status: row.status };
  }

  async function addFriendship(a, b) {
    const [user_low, user_high] = [a, b].sort();
    const created_at = new Date().toISOString();
    try {
      await friendships.insertOne({ user_low, user_high, created_at });
    } catch (e) {
      if (e && e.code === 11000) return;
      throw e;
    }
  }

  async function areFriends(a, b) {
    const [user_low, user_high] = [a, b].sort();
    const one = await friendships.findOne({ user_low, user_high });
    return !!one;
  }

  async function listIncomingRequests(userId) {
    const cursor = friendRequests
      .aggregate([
        { $match: { to_user: userId, status: "pending" } },
        { $sort: { created_at: -1 } },
        {
          $lookup: {
            from: "users",
            localField: "from_user",
            foreignField: "_id",
            as: "fromUser",
          },
        },
        { $unwind: "$fromUser" },
        {
          $project: {
            id: "$_id",
            from_user: 1,
            from_username: "$fromUser.username",
            from_display_name: "$fromUser.display_name",
            created_at: 1,
          },
        },
      ])
      .limit(100);
    return cursor.toArray();
  }

  async function listFriends(userId) {
    const cursor = friendships
      .aggregate([
        { $match: { $or: [{ user_low: userId }, { user_high: userId }] } },
        {
          $addFields: {
            peerId: {
              $cond: [{ $eq: ["$user_low", userId] }, "$user_high", "$user_low"],
            },
          },
        },
        {
          $lookup: {
            from: "users",
            localField: "peerId",
            foreignField: "_id",
            as: "peer",
          },
        },
        { $unwind: "$peer" },
        { $replaceRoot: { newRoot: { id: "$peer._id", username: "$peer.username", display_name: "$peer.display_name" } } },
        { $sort: { username: 1 } },
      ])
      .limit(500);
    return cursor.toArray();
  }

  async function insertMessage({ user_low, user_high, sender_id, body }) {
    const [lo, hi] = [user_low, user_high].sort();
    const id = randomUUID();
    const created_ms = Date.now();
    await messages.insertOne({
      _id: id,
      user_low: lo,
      user_high: hi,
      sender_id,
      body,
      created_ms,
    });
    return { id, sender_id, body, ts: created_ms };
  }

  async function listMessages(user_low, user_high, limit = 100) {
    const [lo, hi] = [user_low, user_high].sort();
    const rows = await messages
      .find({ user_low: lo, user_high: hi })
      .sort({ created_ms: 1 })
      .limit(limit)
      .toArray();
    return rows.map((m) => ({
      id: m._id,
      sender_id: m.sender_id,
      body: m.body,
      ts: m.created_ms,
    }));
  }

  return {
    mode: "mongodb",
    client,
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

module.exports = { createMongoDb };
