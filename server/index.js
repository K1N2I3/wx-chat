const http = require("http");
const express = require("express");
const cors = require("cors");
const { Server } = require("socket.io");

const app = express();

const corsOrigin =
  process.env.CORS_ORIGIN === "*"
    ? true
    : (process.env.CORS_ORIGIN || "").split(",").map((s) => s.trim()).filter(Boolean);

app.use(
  cors({
    origin: corsOrigin.length ? corsOrigin : true,
    credentials: true,
  })
);

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "wx-chat" });
});

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: corsOrigin.length ? corsOrigin : true,
    methods: ["GET", "POST"],
    credentials: true,
  },
  transports: ["websocket", "polling"],
  pingInterval: 20000,
  pingTimeout: 25000,
});

/** roomId -> last N messages (for late joiners) */
const history = new Map();
const HISTORY_LIMIT = 80;

function pushHistory(roomId, entry) {
  const list = history.get(roomId) || [];
  list.push(entry);
  while (list.length > HISTORY_LIMIT) list.shift();
  history.set(roomId, list);
}

io.on("connection", (socket) => {
  socket.on("join", ({ roomId, nickname }) => {
    if (!roomId || typeof roomId !== "string") return;
    const rid = roomId.slice(0, 64).trim();
    if (!rid) return;
    const name = String(nickname || "访客").slice(0, 32);
    for (const room of socket.rooms) {
      if (room !== socket.id) socket.leave(room);
    }
    socket.join(rid);
    socket.data.roomId = rid;
    socket.data.nickname = name;

    const past = history.get(rid) || [];
    socket.emit("history", { messages: past });

    socket.to(rid).emit("presence", {
      type: "join",
      nickname: name,
      ts: Date.now(),
    });
  });

  socket.on("message", ({ text }) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const raw = String(text ?? "").trim();
    if (!raw) return;
    const body = raw.slice(0, 4000);
    const from = socket.data.nickname || "访客";
    const payload = {
      id: `${Date.now()}-${socket.id}`,
      from,
      text: body,
      ts: Date.now(),
    };
    pushHistory(roomId, payload);
    io.to(roomId).emit("message", payload);
  });

  socket.on("disconnecting", () => {
    const roomId = socket.data.roomId;
    const name = socket.data.nickname;
    if (roomId && name) {
      socket.to(roomId).emit("presence", {
        type: "leave",
        nickname: name,
        ts: Date.now(),
      });
    }
  });
});

const port = Number(process.env.PORT) || 3001;
server.listen(port, "0.0.0.0", () => {
  console.log(`wx-chat server listening on ${port}`);
});
