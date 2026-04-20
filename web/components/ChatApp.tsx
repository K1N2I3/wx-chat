"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
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

function avatarChar(name: string) {
  const t = name.trim();
  return t ? t[0].toUpperCase() : "?";
}

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
  const [storageHint, setStorageHint] = useState<string | null>(null);

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

  useEffect(() => {
    if (!apiBase) return;
    fetch(`${apiBase}/health`)
      .then((r) => r.json())
      .then((d: { storage?: string }) => {
        if (d.storage === "sqlite") setStorageHint("数据保存在服务器 SQLite 文件");
        else if (d.storage === "postgres") setStorageHint("数据保存在 PostgreSQL");
        else if (d.storage === "memory") setStorageHint("当前为内存模式，数据不持久");
      })
      .catch(() => setStorageHint(null));
  }, [apiBase]);

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
    selectedRef.current = selected;
  }, [selected]);

  useEffect(() => {
    meRef.current = me;
  }, [me]);

  useEffect(() => {
    if (!listRef.current) return;
    listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages]);

  const joinDmRoom = useCallback((f: Friend) => {
    const s = socketRef.current;
    if (!s?.connected) return;
    s.emit(
      "join_dm",
      { peerUserId: f.id },
      (res: {
        ok?: boolean;
        history?: { id: string; text: string; ts: number; fromMe: boolean }[];
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
    s.emit("dm_message", { peerUserId: selected.id, text: t }, () => {});
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
    } catch {
      /* ignore */
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

  if (!apiBase) {
    return (
      <div className="wx-auth-page">
        <div className="wx-auth-card">
          <div className="wx-brand">
            <div className="wx-brand-mark">微</div>
            <h1>需要配置后端地址</h1>
            <p>
              在 Vercel 设置环境变量 <span className="wx-mono">NEXT_PUBLIC_SOCKET_URL</span>
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (screen === "login" || screen === "register") {
    return (
      <div className="wx-auth-page">
        <div className="wx-auth-card">
          <div className="wx-brand">
            <div className="wx-brand-mark">微</div>
            <h1>{screen === "login" ? "登录" : "注册账号"}</h1>
            <p>账号、密码与聊天记录由后端持久保存（PostgreSQL 或 SQLite）</p>
          </div>

          <div className="wx-field">
            <label>账号</label>
            <input
              className="wx-input"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="小写字母、数字、下划线"
            />
          </div>
          <div className="wx-field">
            <label>密码 {screen === "register" && "（至少 6 位）"}</label>
            <input
              className="wx-input"
              type="password"
              autoComplete={screen === "login" ? "current-password" : "new-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          {screen === "register" && (
            <div className="wx-field">
              <label>显示名称</label>
              <input
                className="wx-input"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="好友看到的名字"
                maxLength={32}
              />
            </div>
          )}
          {formErr && <p className="wx-form-err">{formErr}</p>}
          <button
            type="button"
            className="wx-btn-primary"
            onClick={screen === "login" ? onLogin : onRegister}
          >
            {screen === "login" ? "登录" : "注册并进入"}
          </button>
          <button
            type="button"
            className="wx-btn-ghost"
            onClick={() => {
              setFormErr(null);
              setScreen(screen === "login" ? "register" : "login");
            }}
          >
            {screen === "login" ? "没有账号？去注册" : "已有账号？去登录"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="wx-shell">
      <div className="wx-app">
        <aside className="wx-sidebar">
          <div className="wx-profile">
            <div className="wx-avatar">{me ? avatarChar(me.displayName) : "?"}</div>
            <div className="wx-profile-info">
              <div className="wx-profile-name">{me?.displayName}</div>
              <div className="wx-profile-id">@{me?.username}</div>
            </div>
            <button type="button" className="wx-btn-logout" onClick={logout}>
              退出
            </button>
          </div>

          <div className="wx-status-pill" data-on={socketStatus === "on"}>
            {socketStatus === "on"
              ? "实时连接正常"
              : socketStatus === "connecting"
                ? "正在连接…"
                : socketStatus === "err"
                  ? "连接异常"
                  : "未连接"}
            {storageHint && ` · ${storageHint}`}
          </div>

          <div className="wx-section-label">新朋友</div>
          {incoming.length === 0 && <div className="wx-hint">暂无申请</div>}
          {incoming.map((r) => (
            <div key={r.id} className="wx-incoming-item">
              <div>
                <div className="wx-friend-name">{r.from_display_name}</div>
                <div className="wx-friend-sub">@{r.from_username}</div>
              </div>
              <div className="wx-incoming-actions">
                <button type="button" className="wx-btn-xs accept" onClick={() => onAccept(r.id)}>
                  接受
                </button>
                <button type="button" className="wx-btn-xs reject" onClick={() => onReject(r.id)}>
                  拒绝
                </button>
              </div>
            </div>
          ))}

          <div className="wx-section-label">添加好友</div>
          <div className="wx-add-row">
            <input
              className="wx-input"
              placeholder="输入对方账号"
              value={addTarget}
              onChange={(e) => setAddTarget(e.target.value)}
            />
            <button type="button" className="wx-btn-sm" onClick={onAddFriend}>
              添加
            </button>
          </div>
          {addMsg && <div className="wx-hint">{addMsg}</div>}

          <div className="wx-section-label">好友</div>
          <div className="wx-friend-list">
            {friends.map((f) => (
              <button
                key={f.id}
                type="button"
                className="wx-friend-item"
                data-active={selected?.id === f.id}
                onClick={() => openChat(f)}
              >
                <div className="wx-avatar wx-avatar--sm">{avatarChar(f.display_name)}</div>
                <div className="wx-friend-meta">
                  <div className="wx-friend-name">{f.display_name}</div>
                  <div className="wx-friend-sub">@{f.username}</div>
                </div>
              </button>
            ))}
            {friends.length === 0 && (
              <div className="wx-empty-side">添加好友后即可开始聊天，聊天记录会保存在服务器</div>
            )}
          </div>
        </aside>

        <section className="wx-chat">
          {!selected ? (
            <div className="wx-chat-empty">选择一位好友开始聊天</div>
          ) : (
            <>
              <div className="wx-chat-header">
                <div className="wx-avatar wx-avatar--xs">{avatarChar(selected.display_name)}</div>
                <div>
                  <h2>{selected.display_name}</h2>
                  <span>@{selected.username}</span>
                </div>
              </div>
              <div ref={listRef} className="wx-msg-scroll">
                {messages.map((m) => (
                  <div key={m.id} className={`wx-msg-row ${m.fromMe ? "me" : ""}`}>
                    <div className={`wx-bubble ${m.fromMe ? "me" : "them"}`}>
                      {!m.fromMe && m.fromLabel && <div className="wx-from">{m.fromLabel}</div>}
                      <div>{m.text}</div>
                      <time>
                        {new Date(m.ts).toLocaleTimeString("zh-CN", {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </time>
                    </div>
                  </div>
                ))}
              </div>
              <div className="wx-composer">
                <input
                  className="wx-input"
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
                <button type="button" className="wx-btn-sm" onClick={sendDm} disabled={!input.trim()}>
                  发送
                </button>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
