"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { io, type Socket } from "socket.io-client";

type ChatMessage = {
  id: string;
  from: string;
  text: string;
  ts: number;
};

type Presence = {
  type: "join" | "leave";
  nickname: string;
  ts: number;
};

function defaultNickname() {
  if (typeof window === "undefined") return "访客";
  const k = "wx-chat-nickname";
  const saved = localStorage.getItem(k);
  if (saved) return saved;
  const n = `用户${Math.floor(Math.random() * 9000 + 1000)}`;
  localStorage.setItem(k, n);
  return n;
}

export function ChatApp() {
  const serverUrl =
    process.env.NEXT_PUBLIC_SOCKET_URL?.replace(/\/$/, "") || "";

  const [nickname, setNickname] = useState("");
  const [roomId, setRoomId] = useState("");
  const [joined, setJoined] = useState(false);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [presence, setPresence] = useState<Presence[]>([]);
  const [status, setStatus] = useState<"idle" | "connecting" | "connected" | "error">(
    "idle"
  );
  const [err, setErr] = useState<string | null>(null);

  const socketRef = useRef<Socket | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setNickname(defaultNickname());
  }, []);

  useEffect(() => {
    if (!listRef.current) return;
    listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages, presence]);

  const canJoin = useMemo(() => {
    return Boolean(serverUrl && roomId.trim() && nickname.trim());
  }, [serverUrl, roomId, nickname]);

  const disconnect = useCallback(() => {
    const s = socketRef.current;
    if (s) {
      s.removeAllListeners();
      s.disconnect();
      socketRef.current = null;
    }
    setJoined(false);
    setStatus("idle");
  }, []);

  const connectAndJoin = useCallback(() => {
    if (!canJoin || !serverUrl) return;
    setErr(null);
    setStatus("connecting");

    const s = io(serverUrl, {
      path: "/socket.io/",
      transports: ["websocket", "polling"],
      reconnection: true,
      reconnectionAttempts: 8,
      reconnectionDelay: 800,
      timeout: 20000,
    });
    socketRef.current = s;

    s.on("connect", () => {
      setStatus("connected");
      s.emit("join", {
        roomId: roomId.trim(),
        nickname: nickname.trim(),
      });
      setJoined(true);
      try {
        localStorage.setItem("wx-chat-nickname", nickname.trim());
      } catch {
        /* ignore */
      }
    });

    s.on("connect_error", (e) => {
      setStatus("error");
      setErr(e.message || "连接失败");
      setJoined(false);
    });

    s.on("disconnect", (reason) => {
      if (reason === "io server disconnect") {
        setErr("服务器断开连接");
      }
      setJoined(false);
    });

    s.on("history", (data: { messages: ChatMessage[] }) => {
      setMessages(Array.isArray(data?.messages) ? data.messages : []);
    });

    s.on("message", (msg: ChatMessage) => {
      setMessages((prev) => [...prev, msg]);
    });

    s.on("presence", (p: Presence) => {
      setPresence((prev) => [...prev.slice(-20), p]);
    });
  }, [canJoin, serverUrl, roomId, nickname]);

  const send = useCallback(() => {
    const s = socketRef.current;
    const t = input.trim();
    if (!s || !joined || !t) return;
    s.emit("message", { text: t });
    setInput("");
  }, [input, joined]);

  useEffect(() => {
    return () => disconnect();
  }, [disconnect]);

  if (!serverUrl) {
    return (
      <main style={shell}>
        <div style={card}>
          <h1 style={title}>WX 网页聊天</h1>
          <p style={{ color: "var(--muted)", margin: "0 0 1rem" }}>
            请先在 Vercel 项目环境变量中设置{" "}
            <code style={code}>NEXT_PUBLIC_SOCKET_URL</code> 为你的 Render 后端地址（例如{" "}
            <code style={code}>https://你的服务.onrender.com</code>），然后重新部署。
          </p>
        </div>
      </main>
    );
  }

  return (
    <main style={shell}>
      <div style={card}>
        <header style={header}>
          <h1 style={title}>WX 网页聊天</h1>
          <span
            style={{
              fontSize: "0.8rem",
              color:
                status === "connected"
                  ? "var(--accent)"
                  : status === "error"
                    ? "var(--danger)"
                    : "var(--muted)",
            }}
          >
            {status === "connected"
              ? "已连接"
              : status === "connecting"
                ? "连接中…"
                : status === "error"
                  ? "连接异常"
                  : "未连接"}
          </span>
        </header>

        {!joined ? (
          <section style={formSection}>
            <label style={label}>
              后端地址（只读）
              <input style={inputStyle} readOnly value={serverUrl} />
            </label>
            <label style={label}>
              房间号（跨设备相同即可互聊）
              <input
                style={inputStyle}
                placeholder="例如 family / project-a"
                value={roomId}
                onChange={(e) => setRoomId(e.target.value)}
                autoComplete="off"
              />
            </label>
            <label style={label}>
              昵称
              <input
                style={inputStyle}
                value={nickname}
                onChange={(e) => setNickname(e.target.value)}
                maxLength={32}
              />
            </label>
            {err && <p style={{ color: "var(--danger)", margin: "0 0 0.5rem" }}>{err}</p>}
            <button
              type="button"
              style={btnPrimary}
              disabled={!canJoin || status === "connecting"}
              onClick={connectAndJoin}
            >
              进入房间
            </button>
          </section>
        ) : (
          <>
            <div style={roomBar}>
              <span>
                房间 <strong>{roomId.trim()}</strong>
              </span>
              <button type="button" style={btnGhost} onClick={disconnect}>
                离开
              </button>
            </div>
            <div ref={listRef} style={msgList}>
              {presence.map((p, i) => (
                <div key={`${p.ts}-${i}`} style={systemLine}>
                  {p.type === "join" ? "→" : "←"} {p.nickname}{" "}
                  {p.type === "join" ? "加入" : "离开"}
                </div>
              ))}
              {messages.map((m) => {
                const mine = m.from === nickname.trim();
                return (
                  <div
                    key={m.id}
                    style={{
                      ...bubbleRow,
                      justifyContent: mine ? "flex-end" : "flex-start",
                    }}
                  >
                    <div
                      style={{
                        ...bubble,
                        background: mine ? "var(--bubble-me)" : "var(--bubble-them)",
                        color: mine ? "#fff" : "var(--text)",
                      }}
                    >
                      {!mine && <div style={nameTag}>{m.from}</div>}
                      <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                        {m.text}
                      </div>
                      <div style={timeTag}>
                        {new Date(m.ts).toLocaleTimeString("zh-CN", {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
            <div style={composer}>
              <input
                style={{ ...inputStyle, flex: 1 }}
                placeholder="输入消息，Enter 发送"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
              />
              <button type="button" style={btnPrimary} onClick={send} disabled={!input.trim()}>
                发送
              </button>
            </div>
          </>
        )}
      </div>
    </main>
  );
}

const shell: CSSProperties = {
  minHeight: "100dvh",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "1rem",
};

const card: CSSProperties = {
  width: "100%",
  maxWidth: 480,
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: 12,
  padding: "1.25rem",
  boxShadow: "0 12px 40px rgba(0,0,0,0.35)",
};

const header: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  marginBottom: "1rem",
  gap: "0.75rem",
};

const title: CSSProperties = {
  margin: 0,
  fontSize: "1.25rem",
  fontWeight: 600,
};

const formSection: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.75rem",
};

const label: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
  fontSize: "0.85rem",
  color: "var(--muted)",
};

const inputStyle: CSSProperties = {
  padding: "10px 12px",
  borderRadius: 8,
  border: "1px solid var(--border)",
  background: "var(--bg)",
  color: "var(--text)",
  fontSize: "1rem",
  outline: "none",
};

const btnPrimary: CSSProperties = {
  padding: "10px 16px",
  borderRadius: 8,
  border: "none",
  background: "var(--accent)",
  color: "#fff",
  fontWeight: 600,
  cursor: "pointer",
  fontSize: "1rem",
};

const btnGhost: CSSProperties = {
  padding: "6px 12px",
  borderRadius: 8,
  border: "1px solid var(--border)",
  background: "transparent",
  color: "var(--muted)",
  cursor: "pointer",
  fontSize: "0.85rem",
};

const roomBar: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  marginBottom: "0.75rem",
  fontSize: "0.9rem",
  color: "var(--muted)",
};

const msgList: CSSProperties = {
  height: "min(52vh, 420px)",
  overflowY: "auto",
  padding: "4px 0",
  marginBottom: "0.75rem",
  borderTop: "1px solid var(--border)",
  borderBottom: "1px solid var(--border)",
};

const bubbleRow: CSSProperties = {
  display: "flex",
  marginBottom: "0.5rem",
};

const bubble: CSSProperties = {
  maxWidth: "88%",
  padding: "8px 12px",
  borderRadius: 12,
  fontSize: "0.95rem",
};

const nameTag: CSSProperties = {
  fontSize: "0.75rem",
  color: "var(--muted)",
  marginBottom: 4,
};

const timeTag: CSSProperties = {
  fontSize: "0.7rem",
  opacity: 0.75,
  marginTop: 4,
  textAlign: "right",
};

const systemLine: CSSProperties = {
  textAlign: "center",
  fontSize: "0.75rem",
  color: "var(--muted)",
  margin: "0.35rem 0",
};

const composer: CSSProperties = {
  display: "flex",
  gap: 8,
  alignItems: "center",
};

const code: CSSProperties = {
  background: "var(--bg)",
  padding: "2px 6px",
  borderRadius: 4,
  fontSize: "0.85em",
};
