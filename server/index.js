const http = require("http");
const express = require("express");
const cors = require("cors");
const { Server } = require("socket.io");
const { createDb, convKey } = require("./lib/db");
const {
  hashPassword,
  verifyPassword,
  signToken,
  verifyToken,
  authMiddleware,
} = require("./lib/auth");

const app = express();
app.use(express.json({ limit: "512kb" }));

function normalizeOrigin(input) {
  return String(input || "")
    .trim()
    .replace(/^['"]|['"]$/g, "")
    .replace(/\/+$/, "");
}

const originRaw = process.env.CORS_ORIGIN || "";
const allowAllOrigins = originRaw.trim() === "*" || originRaw.trim() === "";
const allowedOrigins = allowAllOrigins
  ? []
  : originRaw
      .split(",")
      .map((s) => normalizeOrigin(s))
      .filter(Boolean);

function isAllowedOrigin(origin) {
  if (allowAllOrigins) return true;
  if (!origin) return true;
  const normalized = normalizeOrigin(origin);
  return allowedOrigins.some((allowed) => normalizeOrigin(allowed) === normalized);
}

app.use(
  cors({
    origin(origin, cb) {
      cb(null, isAllowedOrigin(origin));
    },
    credentials: true,
  })
);

function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
  };
}

function registerHttpRoutes(db) {
  app.post("/api/auth/register", async (req, res) => {
    try {
      const username = String(req.body?.username || "")
        .trim()
        .toLowerCase();
      const password = String(req.body?.password || "");
      const displayName = String(req.body?.displayName || "").trim().slice(0, 32);
      if (!username || !password || !displayName) {
        res.status(400).json({ error: "请填写账号、密码和显示名称" });
        return;
      }
      if (!/^[a-z0-9_]{3,32}$/.test(username)) {
        res.status(400).json({ error: "账号为 3–32 位小写字母、数字或下划线" });
        return;
      }
      if (password.length < 6) {
        res.status(400).json({ error: "密码至少 6 位" });
        return;
      }
      const exists = await db.findUserByUsername(username);
      if (exists) {
        res.status(409).json({ error: "该账号已被注册" });
        return;
      }
      const password_hash = await hashPassword(password);
      const row = await db.createUser({
        username,
        password_hash,
        display_name: displayName,
      });
      const token = signToken(row);
      res.status(201).json({ token, user: publicUser(row) });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: "注册失败" });
    }
  });

  app.post("/api/auth/login", async (req, res) => {
    try {
      const username = String(req.body?.username || "")
        .trim()
        .toLowerCase();
      const password = String(req.body?.password || "");
      if (!username || !password) {
        res.status(400).json({ error: "请填写账号和密码" });
        return;
      }
      const row = await db.findUserByUsername(username);
      if (!row || !(await verifyPassword(password, row.password_hash))) {
        res.status(401).json({ error: "账号或密码错误" });
        return;
      }
      const token = signToken(row);
      res.json({ token, user: publicUser(row) });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: "登录失败" });
    }
  });

  app.get("/api/me", authMiddleware, async (req, res) => {
    const row = await db.findUserById(req.user.id);
    if (!row) {
      res.status(404).json({ error: "用户不存在" });
      return;
    }
    res.json({ user: publicUser(row) });
  });

  app.get("/api/friends", authMiddleware, async (req, res) => {
    const list = await db.listFriends(req.user.id);
    res.json({ friends: list });
  });

  app.get("/api/friends/incoming", authMiddleware, async (req, res) => {
    const list = await db.listIncomingRequests(req.user.id);
    res.json({ requests: list });
  });

  app.post("/api/friends/request", authMiddleware, async (req, res) => {
    try {
      const target = String(req.body?.targetUsername || "")
        .trim()
        .toLowerCase();
      if (!target) {
        res.status(400).json({ error: "请填写对方账号" });
        return;
      }
      if (target === req.user.username) {
        res.status(400).json({ error: "不能添加自己为好友" });
        return;
      }
      const peer = await db.findUserByUsername(target);
      if (!peer) {
        res.status(404).json({ error: "未找到该账号" });
        return;
      }
      if (await db.areFriends(req.user.id, peer.id)) {
        res.status(409).json({ error: "你们已经是好友" });
        return;
      }
      const reverse = await db.findPendingReverse(req.user.id, peer.id);
      if (reverse) {
        await db.markRequestAccepted(reverse.id);
        await db.addFriendship(req.user.id, peer.id);
        res.json({ ok: true, mutual: true, message: "已互为好友" });
        return;
      }
      const row = await db.createFriendRequest(req.user.id, peer.id);
      res.json({ ok: true, requestId: row.id, message: "好友申请已发送" });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: "发送失败" });
    }
  });

  app.post("/api/friends/accept", authMiddleware, async (req, res) => {
    try {
      const requestId = String(req.body?.requestId || "").trim();
      if (!requestId) {
        res.status(400).json({ error: "缺少 requestId" });
        return;
      }
      const r = await db.findRequestById(requestId);
      if (!r || r.status !== "pending") {
        res.status(404).json({ error: "申请不存在或已处理" });
        return;
      }
      if (r.to_user !== req.user.id) {
        res.status(403).json({ error: "无权处理该申请" });
        return;
      }
      await db.markRequestAccepted(requestId);
      await db.addFriendship(r.from_user, r.to_user);
      res.json({ ok: true });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: "接受失败" });
    }
  });

  app.post("/api/friends/reject", authMiddleware, async (req, res) => {
    try {
      const requestId = String(req.body?.requestId || "").trim();
      if (!requestId) {
        res.status(400).json({ error: "缺少 requestId" });
        return;
      }
      const r = await db.findRequestById(requestId);
      if (!r || r.status !== "pending") {
        res.status(404).json({ error: "申请不存在或已处理" });
        return;
      }
      if (r.to_user !== req.user.id) {
        res.status(403).json({ error: "无权处理该申请" });
        return;
      }
      await db.markRequestRejected(requestId);
      res.json({ ok: true });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: "拒绝失败" });
    }
  });
}

function dmRoomKey(a, b) {
  return `dm:${convKey(a, b)}`;
}

function registerSocketIO(io, db) {
  async function emitUnreadCounts(userId) {
    if (!db.getUnreadCounts) return;
    try {
      const counts = await db.getUnreadCounts(userId);
      io.to(`user:${userId}`).emit("unread_counts", { counts });
    } catch (e) {
      console.error("emitUnreadCounts error:", e);
    }
  }

  io.use((socket, next) => {
    try {
      const token =
        socket.handshake.auth?.token ||
        socket.handshake.headers?.authorization?.replace(/^Bearer\s+/i, "");
      if (!token || typeof token !== "string") {
        next(new Error("未登录"));
        return;
      }
      const p = verifyToken(token);
      socket.data.userId = p.sub;
      socket.data.username = p.username;
      socket.data.displayName = p.displayName;
      next();
    } catch {
      next(new Error("登录已过期"));
    }
  });

  io.on("connection", (socket) => {
    const uid = socket.data.userId;
    socket.join(`user:${uid}`);
    emitUnreadCounts(uid);

    socket.on("join_dm", async ({ peerUserId }, cb) => {
      try {
        const peer = String(peerUserId || "").trim();
        if (!peer || peer === uid) {
          if (typeof cb === "function") cb({ ok: false, error: "无效的好友" });
          return;
        }
        if (!(await db.areFriends(uid, peer))) {
          if (typeof cb === "function") cb({ ok: false, error: "仅可与好友聊天" });
          return;
        }
        for (const room of socket.rooms) {
          if (room.startsWith("dm:")) socket.leave(room);
        }
        const room = dmRoomKey(uid, peer);
        socket.join(room);
        socket.data.dmPeer = peer;
        const [lo, hi] = [uid, peer].sort();
        const rows = await db.listMessages(lo, hi, 100);
        const history = rows.map((m) => ({
          id: m.id,
          text: m.body,
          ts: Number(m.ts),
          fromMe: m.sender_id === uid,
          readByRecipient: !!m.read_by_recipient,
        }));
        const readChanged = db.markMessagesRead
          ? await db.markMessagesRead(uid, peer)
          : 0;
        if (readChanged > 0) {
          io.to(room).emit("dm_read", {
            readerUserId: uid,
            peerUserId: peer,
            ts: Date.now(),
          });
        }
        await emitUnreadCounts(uid);
        if (typeof cb === "function") cb({ ok: true, history });
      } catch (e) {
        console.error(e);
        if (typeof cb === "function") cb({ ok: false, error: "加载会话失败" });
      }
    });

    socket.on("dm_message", async ({ peerUserId, text }, cb) => {
      try {
        const peer = String(peerUserId || "").trim();
        const raw = String(text ?? "").trim();
        if (!peer || !raw) {
          if (typeof cb === "function") cb({ ok: false });
          return;
        }
        if (!(await db.areFriends(uid, peer))) {
          if (typeof cb === "function") cb({ ok: false, error: "仅可与好友聊天" });
          return;
        }
        const body = raw.slice(0, 4000);
        const [lo, hi] = [uid, peer].sort();
        const saved = await db.insertMessage({
          user_low: lo,
          user_high: hi,
          sender_id: uid,
          body,
        });
        const ts = Number(saved.ts);
        const payload = {
          id: saved.id,
          text: body,
          ts,
          fromUserId: uid,
          fromUsername: socket.data.username,
          fromDisplayName: socket.data.displayName,
          readByRecipient: false,
        };
        const room = dmRoomKey(uid, peer);
        io.to(room).emit("dm_message", payload);
        await emitUnreadCounts(peer);
        await emitUnreadCounts(uid);
        if (typeof cb === "function") cb({ ok: true, id: saved.id, ts });
      } catch (e) {
        console.error(e);
        if (typeof cb === "function") cb({ ok: false, error: "发送失败" });
      }
    });

    socket.on("mark_dm_read", async ({ peerUserId }, cb) => {
      try {
        const peer = String(peerUserId || "").trim();
        if (!peer || peer === uid) {
          if (typeof cb === "function") cb({ ok: false });
          return;
        }
        if (!(await db.areFriends(uid, peer))) {
          if (typeof cb === "function") cb({ ok: false, error: "仅可与好友聊天" });
          return;
        }
        const changed = db.markMessagesRead ? await db.markMessagesRead(uid, peer) : 0;
        if (changed > 0) {
          io.to(dmRoomKey(uid, peer)).emit("dm_read", {
            readerUserId: uid,
            peerUserId: peer,
            ts: Date.now(),
          });
        }
        await emitUnreadCounts(uid);
        if (typeof cb === "function") cb({ ok: true, changed });
      } catch (e) {
        console.error(e);
        if (typeof cb === "function") cb({ ok: false, error: "已读同步失败" });
      }
    });

    socket.on("disconnecting", () => {
      /* optional presence */
    });
  });
}

createDb()
  .then((db) => {
    app.get("/health", (_req, res) => {
      res.json({
        ok: true,
        service: "wx-chat",
        storage: db.mode,
        ...(db.filePath ? { sqlitePath: db.filePath } : {}),
      });
    });

    registerHttpRoutes(db);

    const server = http.createServer(app);
    const io = new Server(server, {
      cors: {
        origin(origin, cb) {
          cb(null, isAllowedOrigin(origin));
        },
        methods: ["GET", "POST"],
        credentials: true,
      },
      transports: ["websocket", "polling"],
      pingInterval: 20000,
      pingTimeout: 25000,
    });

    registerSocketIO(io, db);

    const port = Number(process.env.PORT) || 3001;
    server.listen(port, "0.0.0.0", () => {
      console.log(
        `[cors] ${allowAllOrigins ? "allow all origins" : `allow list: ${allowedOrigins.join(", ")}`}`
      );
      console.log(`wx-chat server listening on ${port} (db: ${db.mode})`);
    });
  })
  .catch((err) => {
    console.error("Failed to start:", err);
    process.exit(1);
  });
