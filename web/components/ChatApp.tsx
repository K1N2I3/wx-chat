"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

type PeerPreview = { text: string; ts: number };

function avatarChar(name: string) {
  const t = name.trim();
  return t ? t[0].toUpperCase() : "?";
}

function formatListTime(ts: number) {
  const d = new Date(ts);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) {
    return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  }
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const ySame =
    d.getFullYear() === yesterday.getFullYear() &&
    d.getMonth() === yesterday.getMonth() &&
    d.getDate() === yesterday.getDate();
  if (ySame) return `昨天 ${d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`;
  return d.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
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

function IconChat() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconContacts() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconLeave() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
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
  const [listSearch, setListSearch] = useState("");
  const [addPanelOpen, setAddPanelOpen] = useState(false);
  const [peerPreview, setPeerPreview] = useState<Record<string, PeerPreview>>({});

  const [selected, setSelected] = useState<Friend | null>(null);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [input, setInput] = useState("");
  const [socketStatus, setSocketStatus] = useState<"off" | "connecting" | "on" | "err">("off");
  const [storageHint, setStorageHint] = useState<string | null>(null);

  const socketRef = useRef<Socket | null>(null);
  const selectedRef = useRef<Friend | null>(null);
  const meRef = useRef<PublicUser | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const bumpPreview = useCallback((peerId: string, text: string) => {
    const t = text.trim().slice(0, 36);
    if (!t) return;
    setPeerPreview((p) => ({ ...p, [peerId]: { text: t, ts: Date.now() } }));
  }, []);

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
    document.documentElement.classList.toggle("wxd-full", screen === "main");
    return () => document.documentElement.classList.remove("wxd-full");
  }, [screen]);

  useEffect(() => {
    if (!apiBase) return;
    fetch(`${apiBase}/health`)
      .then((r) => r.json())
      .then((d: { storage?: string }) => {
        if (d.storage === "mongodb") setStorageHint("MongoDB");
        else if (d.storage === "sqlite") setStorageHint("SQLite");
        else if (d.storage === "postgres") setStorageHint("PostgreSQL");
        else if (d.storage === "memory") setStorageHint("内存");
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
    setPeerPreview({});
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

  useEffect(() => {
    if (!selected || messages.length === 0) return;
    const last = messages[messages.length - 1];
    bumpPreview(selected.id, last.text);
  }, [messages, selected?.id, bumpPreview, selected]);

  const joinDmRoom = useCallback(
    (f: Friend) => {
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
          const hist = res.history || [];
          setMessages(
            hist.map((m) => ({
              id: m.id,
              text: m.text,
              ts: m.ts,
              fromMe: m.fromMe,
              fromLabel: f.display_name,
            }))
          );
          const last = hist[hist.length - 1];
          if (last) bumpPreview(f.id, last.text);
        }
      );
    },
    [bumpPreview]
  );

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
        if (!self) return;
        if (payload.fromUserId !== self.id) {
          bumpPreview(payload.fromUserId, payload.text);
        } else if (sel) {
          bumpPreview(sel.id, payload.text);
        }
        if (!sel) return;
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
  }, [screen, token, apiBase, joinDmRoom, bumpPreview]);

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
    bumpPreview(selected.id, t);
    setInput("");
  }, [input, selected, me, bumpPreview]);

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

  const filteredFriends = useMemo(() => {
    const q = listSearch.trim().toLowerCase();
    if (!q) return friends;
    return friends.filter(
      (f) => f.username.toLowerCase().includes(q) || f.display_name.toLowerCase().includes(q)
    );
  }, [friends, listSearch]);

  if (!apiBase) {
    return (
      <div className="wxd-auth-page">
        <div className="wxd-auth-card">
          <div className="wxd-auth-brand">
            <div className="wxd-auth-logo">微</div>
            <h1>需要配置后端</h1>
            <p>
              在 Vercel 设置 <span className="wxd-mono">NEXT_PUBLIC_SOCKET_URL</span>
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (screen === "login" || screen === "register") {
    return (
      <div className="wxd-auth-page">
        <div className="wxd-auth-card">
          <div className="wxd-auth-brand">
            <div className="wxd-auth-logo">微</div>
            <h1>{screen === "login" ? "登录" : "注册"}</h1>
            <p>账号与聊天记录由服务器持久保存</p>
          </div>

          <div className="wxd-field">
            <label>账号</label>
            <input
              className="wxd-input"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="小写字母、数字、下划线"
            />
          </div>
          <div className="wxd-field">
            <label>密码 {screen === "register" && "（至少 6 位）"}</label>
            <input
              className="wxd-input"
              type="password"
              autoComplete={screen === "login" ? "current-password" : "new-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          {screen === "register" && (
            <div className="wxd-field">
              <label>显示名称</label>
              <input
                className="wxd-input"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="好友看到的名字"
                maxLength={32}
              />
            </div>
          )}
          {formErr && <p className="wxd-form-err">{formErr}</p>}
          <button
            type="button"
            className="wxd-btn-primary"
            onClick={screen === "login" ? onLogin : onRegister}
          >
            {screen === "login" ? "登录" : "注册并进入"}
          </button>
          <button
            type="button"
            className="wxd-btn-text"
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

  const connLabel =
    socketStatus === "on" ? "已连接" : socketStatus === "connecting" ? "连接中" : socketStatus === "err" ? "异常" : "未连接";

  return (
    <div className="wxd-root">
      <aside className="wxd-rail" aria-label="主导航">
        <div className="wxd-rail-user" title={me?.displayName}>
          {me ? avatarChar(me.displayName) : "?"}
        </div>
        <nav className="wxd-rail-nav">
          <button type="button" className="wxd-rail-btn is-active" title="聊天" aria-label="聊天">
            <IconChat />
          </button>
          <button type="button" className="wxd-rail-btn" title="通讯录" aria-label="通讯录">
            <IconContacts />
          </button>
        </nav>
        <button
          type="button"
          className="wxd-rail-btn danger"
          title="退出登录"
          aria-label="退出登录"
          onClick={logout}
        >
          <IconLeave />
        </button>
      </aside>

      <div className="wxd-list">
        <div className="wxd-list-toolbar">
          <input
            className="wxd-search"
            placeholder="搜索"
            value={listSearch}
            onChange={(e) => setListSearch(e.target.value)}
            aria-label="搜索会话"
          />
          <button
            type="button"
            className="wxd-plus"
            onClick={() => setAddPanelOpen((v) => !v)}
            aria-label="添加"
          >
            +
          </button>
        </div>

        <div className="wxd-list-scroll">
          {addPanelOpen && (
            <div className="wxd-panel-block">
              <div className="wxd-panel-title">添加好友</div>
              <div className="wxd-add-inline">
                <input
                  className="wxd-input"
                  placeholder="对方账号"
                  value={addTarget}
                  onChange={(e) => setAddTarget(e.target.value)}
                />
                <button type="button" className="wxd-btn-mini" onClick={onAddFriend}>
                  添加
                </button>
              </div>
              {addMsg && <div className="wxd-hint">{addMsg}</div>}
            </div>
          )}

          {incoming.length > 0 && (
            <div className="wxd-panel-block">
              <div className="wxd-panel-title">新朋友 · {incoming.length}</div>
              {incoming.map((r) => (
                <div key={r.id} className="wxd-req-row">
                  <div>
                    <div className="wxd-conv-name">{r.from_display_name}</div>
                    <div className="wxd-conv-preview">@{r.from_username}</div>
                  </div>
                  <div className="wxd-req-actions">
                    <button type="button" className="wxd-req-ok" onClick={() => onAccept(r.id)}>
                      接受
                    </button>
                    <button type="button" className="wxd-req-no" onClick={() => onReject(r.id)}>
                      拒绝
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {filteredFriends.length === 0 ? (
            <div className="wxd-list-empty">
              {friends.length === 0
                ? "还没有会话。点击「+」添加好友。"
                : "没有匹配的会话。"}
            </div>
          ) : (
            filteredFriends.map((f) => {
              const pv = peerPreview[f.id];
              return (
                <button
                  key={f.id}
                  type="button"
                  className={`wxd-conv ${selected?.id === f.id ? "is-active" : ""}`}
                  onClick={() => openChat(f)}
                >
                  <div className="wxd-conv-av">{avatarChar(f.display_name)}</div>
                  <div className="wxd-conv-mid">
                    <div className="wxd-conv-top">
                      <span className="wxd-conv-name">{f.display_name}</span>
                      {pv && <span className="wxd-conv-time">{formatListTime(pv.ts)}</span>}
                    </div>
                    <div className="wxd-conv-preview">
                      {pv ? pv.text : `@${f.username}`}
                    </div>
                  </div>
                </button>
              );
            })
          )}
        </div>
      </div>

      <main className="wxd-main">
        {selected ? (
          <>
            <div className="wxd-main-head">
              <div className="wxd-conv-av wxd-conv-av--xs">{avatarChar(selected.display_name)}</div>
              <div>
                <h2>{selected.display_name}</h2>
                <span>@{selected.username}</span>
              </div>
            </div>
            <div className="wxd-status-bar">
              {connLabel}
              {storageHint ? ` · ${storageHint}` : ""}
            </div>
            <div ref={listRef} className="wxd-msgs">
              {messages.map((m) => (
                <div key={m.id} className={`wxd-msg-row ${m.fromMe ? "me" : ""}`}>
                  <div className={`wxd-bubble ${m.fromMe ? "me" : "them"}`}>
                    {!m.fromMe && m.fromLabel && <div className="wxd-from">{m.fromLabel}</div>}
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
            <div className="wxd-compose">
              <input
                className="wxd-input"
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
              <button type="button" className="wxd-btn-mini" onClick={sendDm} disabled={!input.trim()}>
                发送
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="wxd-main-head">
              <h2>微信</h2>
            </div>
            <div className="wxd-status-bar">
              {connLabel}
              {storageHint ? ` · 存储：${storageHint}` : ""}
            </div>
            <div className="wxd-empty-main">
              <div className="wxd-empty-logo" aria-hidden />
              <p className="wxd-empty-tip">在左侧选择一个会话开始聊天</p>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
