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

const TOKEN_KEY = "wx_token";
const USER_KEY = "wx_user";

type PublicUser = { id: string; username: string; displayName: string };

type Friend = { id: string; username: string; display_name: string };

type IncomingReq = {
  id: string;
  from_user: string;
  from_username: string;
  from_display_name: string;
  created_at: string;
};

type UiMessage = {
  id: string;
  text: string;
  ts: number;
  fromMe: boolean;
  fromLabel?: string;
};

async function api<T>(
  base: string,
  path: string,
  opts: RequestInit & { token?: string | null } = {}
): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(opts.headers as Record<string, string>),
  };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const res = await fetch(`${base}${path}`, { ...opts, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || res.statusText);
  return data as T;
}

export function ChatApp() {
  const apiBase = process.env.NEXT_PUBLIC_SOCKET_URL?.replace(/\/$/, "") || "";

  const [screen, setScreen] = useState<"login" | "register" | "main">("login");
  const [token, setToken] = useState<string | null>(null);
  const [me, setMe] = useState<PublicUser | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [formErr, setFormErr] = useState<string | null>(null);

  const [friends, setFriends] = useState<Friend[]>([]);
  const [incoming, setIncoming] = useState<IncomingReq[]>([]);
  const [addTarget, setAddTarget] = useState("");
  const [addMsg, setAddMsg] = useState<string | null>(null);

  const [selected, setSelected] = useState<Friend | null>(null);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [input, setInput] = useState("");
  const [socketStatus, setSocketStatus] = useState<"off" | "connecting" | "on" | "err">("off");

  const socketRef = useRef<Socket | null>(null);
  const selectedRef = useRef<Friend | null>(null);
  const meRef = useRef<PublicUser | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      const t = localStorage.getItem(TOKEN_KEY);
      const u = localStorage.getItem(USER_KEY);
      if (t && u) {
        const parsed = JSON.parse(u) as PublicUser;
        setToken(t);
        setMe(parsed);
        meRef.current = parsed;
        setScreen("main");
      }
    } catch {
      /* ignore */
    }
  }, []);

  const persistAuth = useCallback((t: string, u: PublicUser) => {
    localStorage.setItem(TOKEN_KEY, t);
    localStorage.setItem(USER_KEY, JSON.stringify(u));
    setToken(t);
    setMe(u);
    meRef.current = u;
    setScreen("main");
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    const s = socketRef.current;
    if (s) {
      s.removeAllListeners();
      s.disconnect();
      socketRef.current = null;
    }
    setToken(null);
    setMe(null);
    meRef.current = null;
    selectedRef.current = null;
    setFriends([]);
    setIncoming([]);
    setSelected(null);
    setMessages([]);
    setScreen("login");
    setSocketStatus("off");
  }, []);

  const loadSocial = useCallback(async () => {
    if (!apiBase || !token) return;
    try {
      const [f, inc] = await Promise.all([
        api<{ friends: Friend[] }>(apiBase, "/api/friends", { token }),
        api<{ requests: IncomingReq[] }>(apiBase, "/api/friends/incoming", { token }),
      ]);
      setFriends(f.friends || []);
      setIncoming(inc.requests || []);
    } catch {
      /* silent */
    }
  }, [apiBase, token]);

  useEffect(() => {
    if (screen !== "main" || !token) return;
    loadSocial();
    const id = setInterval(loadSocial, 8000);
    return () => clearInterval(id);
  }, [screen, token, loadSocial]);

  useEffect(() => {
    if (!listRef.current) return;
    listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages]);

  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);

  useEffect(() => {
    meRef.current = me;
  }, [me]);

  const joinDmRoom = useCallback((f: Friend) => {
    const s = socketRef.current;
    if (!s?.connected) return;
    s.emit(
      "join_dm",
      { peerUserId: f.id },
      (res: {
        ok?: boolean;
        history?: { id: string; text: string; ts: number; fromMe: boolean }[];
        error?: string;
      }) => {
        if (!res?.ok) {
          setMessages([]);
          return;
        }
        setMessages(
          (res.history || []).map((m) => ({
            id: m.id,
            text: m.text,
            ts: m.ts,
            fromMe: m.fromMe,
            fromLabel: f.display_name,
          }))
        );
      }
    );
  }, []);

  useEffect(() => {
    if (screen !== "main" || !token || !apiBase) return;

    setSocketStatus("connecting");
    const s = io(apiBase, {
      path: "/socket.io/",
      auth: { token },
      transports: ["websocket", "polling"],
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 600,
      timeout: 20000,
    });
    socketRef.current = s;

    s.on("connect", () => {
      setSocketStatus("on");
      const sel = selectedRef.current;
      if (sel) joinDmRoom(sel);
    });
    s.on("connect_error", () => setSocketStatus("err"));
    s.on("disconnect", () => setSocketStatus("off"));

    s.on(
      "dm_message",
      (payload: {
        id: string;
        text: string;
        ts: number;
        fromUserId: string;
        fromDisplayName?: string;
      }) => {
        const self = meRef.current;
        const sel = selectedRef.current;
        if (!self || !sel) return;
        if (payload.fromUserId !== self.id && payload.fromUserId !== sel.id) return;
        setMessages((prev) => {
          if (prev.some((m) => m.id === payload.id)) return prev;
          return [
            ...prev,
            {
              id: payload.id,
              text: payload.text,
              ts: payload.ts,
              fromMe: payload.fromUserId === self.id,
              fromLabel: payload.fromDisplayName || sel.display_name,
            },
          ];
        });
      }
    );

    return () => {
      s.removeAllListeners();
      s.disconnect();
      socketRef.current = null;
      setSocketStatus("off");
    };
  }, [screen, token, apiBase, joinDmRoom]);

  const openChat = useCallback(
    (f: Friend) => {
      setSelected(f);
      selectedRef.current = f;
      setMessages([]);
      joinDmRoom(f);
    },
    [joinDmRoom]
  );

  const sendDm = useCallback(() => {
    const s = socketRef.current;
    const t = input.trim();
    if (!s || !selected || !t || !me) return;
    s.emit("dm_message", { peerUserId: selected.id, text: t }, (ack: { ok?: boolean }) => {
      if (!ack?.ok) return;
    });
    setInput("");
  }, [input, selected, me]);

  const onLogin = async () => {
    setFormErr(null);
    if (!apiBase) return;
    try {
      const data = await api<{ token: string; user: PublicUser }>(apiBase, "/api/auth/login", {
        method: "POST",
        body: JSON.stringify({
          username: username.trim().toLowerCase(),
          password,
        }),
      });
      persistAuth(data.token, data.user);
      setPassword("");
    } catch (e) {
      setFormErr(e instanceof Error ? e.message : "登录失败");
    }
  };

  const onRegister = async () => {
    setFormErr(null);
    if (!apiBase) return;
    try {
      const data = await api<{ token: string; user: PublicUser }>(apiBase, "/api/auth/register", {
        method: "POST",
        body: JSON.stringify({
          username: username.trim().toLowerCase(),
          password,
          displayName: displayName.trim() || username.trim(),
        }),
      });
      persistAuth(data.token, data.user);
      setPassword("");
    } catch (e) {
      setFormErr(e instanceof Error ? e.message : "注册失败");
    }
  };

  const onAddFriend = async () => {
    setAddMsg(null);
    if (!token || !addTarget.trim()) return;
    try {
      const data = await api<{ mutual?: boolean; message?: string }>(apiBase, "/api/friends/request", {
        method: "POST",
        token,
        body: JSON.stringify({ targetUsername: addTarget.trim().toLowerCase() }),
      });
      setAddMsg(data.mutual ? "已互为好友" : data.message || "已发送");
      setAddTarget("");
      await loadSocial();
    } catch (e) {
      setAddMsg(e instanceof Error ? e.message : "添加失败");
    }
  };

  const onAccept = async (requestId: string) => {
    if (!token) return;
    try {
      await api(apiBase, "/api/friends/accept", {
        method: "POST",
        token,
        body: JSON.stringify({ requestId }),
      });
      await loadSocial();
      if (selected) openChat(selected);
    } catch {
      /* toast optional */
    }
  };

  const onReject = async (requestId: string) => {
    if (!token) return;
    try {
      await api(apiBase, "/api/friends/reject", {
        method: "POST",
        token,
        body: JSON.stringify({ requestId }),
      });
      await loadSocial();
    } catch {
      /* ignore */
    }
  };

  const layoutMain = useMemo(
    () => ({
      ...shell,
      alignItems: "stretch",
      justifyContent: "center",
      maxWidth: 920,
      margin: "0 auto",
    }),
    []
  );

  if (!apiBase) {
    return (
      <main style={shell}>
        <div style={card}>
          <h1 style={title}>微信风格聊天</h1>
          <p style={{ color: "var(--muted)", margin: 0 }}>
            请在 Vercel 环境变量中设置{" "}
            <code style={code}>NEXT_PUBLIC_SOCKET_URL</code> 为 Render 后端地址。
          </p>
        </div>
      </main>
    );
  }

  if (screen === "login" || screen === "register") {
    return (
      <main style={shell}>
        <div style={card}>
          <header style={header}>
            <h1 style={title}>{screen === "login" ? "登录" : "注册账号"}</h1>
          </header>
          <p style={{ color: "var(--muted)", fontSize: "0.85rem", marginTop: 0 }}>
            账号相当于微信号（3–32 位小写字母、数字、下划线），注册后可添加好友再聊天。
          </p>
          <section style={formSection}>
            <label style={label}>
              账号
              <input
                style={inputStyle}
                autoComplete="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="例如 zhangsan"
              />
            </label>
            <label style={label}>
              密码 {screen === "register" && <span style={{ fontWeight: 400 }}>（至少 6 位）</span>}
              <input
                style={inputStyle}
                type="password"
                autoComplete={screen === "login" ? "current-password" : "new-password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            {screen === "register" && (
              <label style={label}>
                显示名称
                <input
                  style={inputStyle}
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="好友看到的名字"
                  maxLength={32}
                />
              </label>
            )}
            {formErr && <p style={{ color: "var(--danger)", margin: 0 }}>{formErr}</p>}
            <button
              type="button"
              style={btnPrimary}
              onClick={screen === "login" ? onLogin : onRegister}
            >
              {screen === "login" ? "登录" : "注册并进入"}
            </button>
            <button
              type="button"
              style={btnGhost}
              onClick={() => {
                setFormErr(null);
                setScreen(screen === "login" ? "register" : "login");
              }}
            >
              {screen === "login" ? "没有账号？去注册" : "已有账号？去登录"}
            </button>
          </section>
        </div>
      </main>
    );
  }

  return (
    <main style={layoutMain}>
      <div style={mainRow}>
        <aside style={sidebar}>
          <div style={sideHead}>
            <div>
              <div style={{ fontWeight: 600 }}>{me?.displayName}</div>
              <div style={{ fontSize: "0.75rem", color: "var(--muted)" }}>@{me?.username}</div>
            </div>
            <button type="button" style={btnGhost} onClick={logout}>
              退出
            </button>
          </div>
          <div style={{ fontSize: "0.75rem", color: "var(--muted)", marginBottom: 8 }}>
            实时连接：
            {socketStatus === "on" ? "已连接" : socketStatus === "connecting" ? "连接中…" : socketStatus === "err" ? "失败" : "未连接"}
          </div>

          <div style={sectionTitle}>新朋友</div>
          {incoming.length === 0 && (
            <div style={{ fontSize: "0.8rem", color: "var(--muted)", marginBottom: 8 }}>暂无申请</div>
          )}
          {incoming.map((r) => (
            <div key={r.id} style={incomingRow}>
              <div>
                <div style={{ fontWeight: 500 }}>{r.from_display_name}</div>
                <div style={{ fontSize: "0.75rem", color: "var(--muted)" }}>@{r.from_username}</div>
              </div>
              <div style={{ display: "flex", gap: 4 }}>
                <button type="button" style={btnMini} onClick={() => onAccept(r.id)}>
                  接受
                </button>
                <button type="button" style={btnMiniGhost} onClick={() => onReject(r.id)}>
                  拒绝
                </button>
              </div>
            </div>
          ))}

          <div style={{ ...sectionTitle, marginTop: 12 }}>添加好友</div>
          <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
            <input
              style={{ ...inputStyle, flex: 1, margin: 0 }}
              placeholder="对方账号"
              value={addTarget}
              onChange={(e) => setAddTarget(e.target.value)}
            />
            <button type="button" style={btnMini} onClick={onAddFriend}>
              添加
            </button>
          </div>
          {addMsg && <div style={{ fontSize: "0.8rem", color: "var(--muted)", marginBottom: 8 }}>{addMsg}</div>}

          <div style={sectionTitle}>好友</div>
          <div style={friendList}>
            {friends.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => openChat(f)}
                style={{
                  ...friendItem,
                  background: selected?.id === f.id ? "var(--border)" : "transparent",
                }}
              >
                <div style={{ fontWeight: 500 }}>{f.display_name}</div>
                <div style={{ fontSize: "0.75rem", color: "var(--muted)" }}>@{f.username}</div>
              </button>
            ))}
            {friends.length === 0 && (
              <div style={{ fontSize: "0.85rem", color: "var(--muted)", padding: "8px 0" }}>
                还没有好友，先添加对方账号发送申请。
              </div>
            )}
          </div>
        </aside>

        <section style={chatPane}>
          {!selected ? (
            <div style={emptyChat}>选择一位好友开始聊天</div>
          ) : (
            <>
              <div style={chatTop}>
                <span style={{ fontWeight: 600 }}>{selected.display_name}</span>
                <span style={{ fontSize: "0.8rem", color: "var(--muted)", marginLeft: 8 }}>
                  @{selected.username}
                </span>
              </div>
              <div ref={listRef} style={msgList}>
                {messages.map((m) => (
                  <div
                    key={m.id}
                    style={{
                      ...bubbleRow,
                      justifyContent: m.fromMe ? "flex-end" : "flex-start",
                    }}
                  >
                    <div
                      style={{
                        ...bubble,
                        background: m.fromMe ? "var(--bubble-me)" : "var(--bubble-them)",
                        color: m.fromMe ? "#fff" : "var(--text)",
                      }}
                    >
                      {!m.fromMe && m.fromLabel && <div style={nameTag}>{m.fromLabel}</div>}
                      <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{m.text}</div>
                      <div style={timeTag}>
                        {new Date(m.ts).toLocaleTimeString("zh-CN", {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              <div style={composer}>
                <input
                  style={{ ...inputStyle, flex: 1 }}
                  placeholder="发消息…"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      sendDm();
                    }
                  }}
                />
                <button type="button" style={btnPrimary} onClick={sendDm} disabled={!input.trim()}>
                  发送
                </button>
              </div>
            </>
          )}
        </section>
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

const mainRow: CSSProperties = {
  display: "flex",
  width: "100%",
  minHeight: "min(88vh, 640px)",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: 12,
  overflow: "hidden",
  boxShadow: "0 12px 40px rgba(0,0,0,0.35)",
};

const sidebar: CSSProperties = {
  width: 280,
  flexShrink: 0,
  borderRight: "1px solid var(--border)",
  padding: "12px",
  display: "flex",
  flexDirection: "column",
  background: "var(--bg)",
};

const sideHead: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  marginBottom: 12,
  gap: 8,
};

const sectionTitle: CSSProperties = {
  fontSize: "0.75rem",
  color: "var(--muted)",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  marginBottom: 6,
};

const incomingRow: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  padding: "8px 0",
  borderBottom: "1px solid var(--border)",
  fontSize: "0.85rem",
};

const friendList: CSSProperties = {
  flex: 1,
  overflowY: "auto",
  marginTop: 4,
};

const friendItem: CSSProperties = {
  width: "100%",
  textAlign: "left",
  padding: "10px 8px",
  border: "none",
  borderRadius: 8,
  cursor: "pointer",
  color: "var(--text)",
  marginBottom: 4,
};

const chatPane: CSSProperties = {
  flex: 1,
  display: "flex",
  flexDirection: "column",
  minWidth: 0,
  background: "var(--surface)",
};

const emptyChat: CSSProperties = {
  flex: 1,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  color: "var(--muted)",
};

const chatTop: CSSProperties = {
  padding: "12px 16px",
  borderBottom: "1px solid var(--border)",
};

const card: CSSProperties = {
  width: "100%",
  maxWidth: 400,
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
  marginBottom: "0.5rem",
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

const btnMini: CSSProperties = {
  padding: "4px 10px",
  borderRadius: 6,
  border: "none",
  background: "var(--accent)",
  color: "#fff",
  fontSize: "0.8rem",
  cursor: "pointer",
};

const btnMiniGhost: CSSProperties = {
  padding: "4px 10px",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "transparent",
  color: "var(--muted)",
  fontSize: "0.8rem",
  cursor: "pointer",
};

const msgList: CSSProperties = {
  flex: 1,
  overflowY: "auto",
  padding: "12px 16px",
};

const bubbleRow: CSSProperties = {
  display: "flex",
  marginBottom: "0.5rem",
};

const bubble: CSSProperties = {
  maxWidth: "78%",
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

const composer: CSSProperties = {
  display: "flex",
  gap: 8,
  padding: "12px 16px",
  borderTop: "1px solid var(--border)",
  alignItems: "center",
};

const code: CSSProperties = {
  background: "var(--bg)",
  padding: "2px 6px",
  borderRadius: 4,
  fontSize: "0.85em",
};
