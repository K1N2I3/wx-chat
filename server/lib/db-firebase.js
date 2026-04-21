const { randomUUID } = require("crypto");
const admin = require("firebase-admin");

function initFirebase() {
  if (admin.apps.length > 0) return admin.app();

  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (serviceAccountJson) {
    const parsed = JSON.parse(serviceAccountJson);
    return admin.initializeApp({
      credential: admin.credential.cert(parsed),
    });
  }

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKeyRaw = process.env.FIREBASE_PRIVATE_KEY;
  if (!projectId || !clientEmail || !privateKeyRaw) {
    throw new Error("缺少 Firebase 凭据环境变量");
  }
  const privateKey = privateKeyRaw.replace(/\\n/g, "\n");
  return admin.initializeApp({
    credential: admin.credential.cert({
      projectId,
      clientEmail,
      privateKey,
    }),
  });
}

async function createFirebaseDb() {
  initFirebase();
  const db = admin.firestore();
  const usersCol = db.collection("users");
  const reqCol = db.collection("friend_requests");
  const friendsCol = db.collection("friendships");
  const msgsCol = db.collection("messages");
  const convCol = db.collection("conversations");

  function convId(a, b) {
    return [a, b].sort().join(":");
  }

  async function findUserByUsername(username) {
    const snap = await usersCol.where("username", "==", username).limit(1).get();
    if (snap.empty) return null;
    const d = snap.docs[0];
    return { id: d.id, ...d.data() };
  }

  async function findUserById(id) {
    const d = await usersCol.doc(id).get();
    if (!d.exists) return null;
    return { id: d.id, ...d.data() };
  }

  async function createUser({ username, password_hash, display_name }) {
    const id = randomUUID();
    const created_at = new Date().toISOString();
    const row = { username, password_hash, display_name, created_at };
    await usersCol.doc(id).set(row);
    return { id, ...row };
  }

  async function createFriendRequest(from_user, to_user) {
    const ex = await reqCol
      .where("from_user", "==", from_user)
      .where("to_user", "==", to_user)
      .where("status", "==", "pending")
      .limit(1)
      .get();
    if (!ex.empty) {
      const d = ex.docs[0];
      return { id: d.id, ...d.data() };
    }
    const id = randomUUID();
    const created_at = new Date().toISOString();
    const row = { from_user, to_user, status: "pending", created_at };
    await reqCol.doc(id).set(row);
    return { id, ...row };
  }

  async function findPendingReverse(from_user, to_user) {
    const snap = await reqCol
      .where("from_user", "==", to_user)
      .where("to_user", "==", from_user)
      .where("status", "==", "pending")
      .limit(1)
      .get();
    if (snap.empty) return null;
    const d = snap.docs[0];
    return { id: d.id, ...d.data() };
  }

  async function markRequestAccepted(id) {
    await reqCol.doc(id).set({ status: "accepted" }, { merge: true });
  }

  async function markRequestRejected(id) {
    await reqCol.doc(id).set({ status: "rejected" }, { merge: true });
  }

  async function findRequestById(id) {
    const d = await reqCol.doc(id).get();
    if (!d.exists) return null;
    return { id: d.id, ...d.data() };
  }

  async function addFriendship(a, b) {
    const [user_low, user_high] = [a, b].sort();
    const id = `${user_low}:${user_high}`;
    await friendsCol.doc(id).set(
      { user_low, user_high, created_at: new Date().toISOString() },
      { merge: true }
    );
  }

  async function areFriends(a, b) {
    const [user_low, user_high] = [a, b].sort();
    const d = await friendsCol.doc(`${user_low}:${user_high}`).get();
    return d.exists;
  }

  async function listIncomingRequests(userId) {
    const snap = await reqCol.where("to_user", "==", userId).where("status", "==", "pending").get();
    const rows = [];
    for (const d of snap.docs) {
      const row = d.data();
      const u = await findUserById(row.from_user);
      if (!u) continue;
      rows.push({
        id: d.id,
        from_user: row.from_user,
        from_username: u.username,
        from_display_name: u.display_name,
        created_at: row.created_at,
      });
    }
    return rows.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  }

  async function listFriends(userId) {
    const [lowSnap, highSnap] = await Promise.all([
      friendsCol.where("user_low", "==", userId).get(),
      friendsCol.where("user_high", "==", userId).get(),
    ]);
    const peerIds = [];
    lowSnap.docs.forEach((d) => peerIds.push(d.data().user_high));
    highSnap.docs.forEach((d) => peerIds.push(d.data().user_low));

    const out = [];
    for (const pid of peerIds) {
      const u = await findUserById(pid);
      if (!u) continue;
      out.push({
        id: u.id,
        username: u.username,
        display_name: u.display_name,
      });
    }
    return out.sort((a, b) => a.username.localeCompare(b.username));
  }

  async function insertMessage({ user_low, user_high, sender_id, body }) {
    const [lo, hi] = [user_low, user_high].sort();
    const id = randomUUID();
    const ts = Date.now();
    const cid = convId(lo, hi);
    const row = {
      user_low: lo,
      user_high: hi,
      sender_id,
      body,
      ts,
      read_by_recipient: false,
    };
    await msgsCol.doc(id).set({
      ...row,
      conv_id: cid,
    });
    await convCol.doc(cid).collection("messages").doc(id).set(row);
    return { id, sender_id, body, ts };
  }

  async function listMessages(user_low, user_high, limit = 100) {
    const [lo, hi] = [user_low, user_high].sort();
    const cid = convId(lo, hi);

    // 优先走会话子集合，避免复合索引要求导致刷新取历史失败
    const sub = await convCol
      .doc(cid)
      .collection("messages")
      .orderBy("ts", "asc")
      .limit(limit)
      .get();
    if (!sub.empty) {
      return sub.docs.map((d) => {
        const m = d.data();
        return {
          id: d.id,
          sender_id: m.sender_id,
          body: m.body,
          ts: m.ts,
          read_by_recipient: !!m.read_by_recipient,
        };
      });
    }

    // 兼容旧数据：回退读取旧 messages 结构（可能需要索引）
    try {
      const snap = await msgsCol
        .where("user_low", "==", lo)
        .where("user_high", "==", hi)
        .orderBy("ts", "asc")
        .limit(limit)
        .get();
      return snap.docs.map((d) => {
        const m = d.data();
        return {
          id: d.id,
          sender_id: m.sender_id,
          body: m.body,
          ts: m.ts,
          read_by_recipient: !!m.read_by_recipient,
        };
      });
    } catch {
      return [];
    }
  }

  async function markMessagesRead(reader_id, peer_id) {
    const [lo, hi] = [reader_id, peer_id].sort();
    const cid = convId(lo, hi);
    const snap = await convCol
      .doc(cid)
      .collection("messages")
      .where("sender_id", "==", peer_id)
      .where("read_by_recipient", "==", false)
      .get();
    if (snap.empty) return 0;
    const batch = db.batch();
    for (const d of snap.docs) {
      batch.update(d.ref, { read_by_recipient: true });
      batch.update(msgsCol.doc(d.id), { read_by_recipient: true });
    }
    await batch.commit();
    return snap.size;
  }

  async function getUnreadCounts(userId) {
    const [asLow, asHigh] = await Promise.all([
      msgsCol.where("user_low", "==", userId).where("read_by_recipient", "==", false).get(),
      msgsCol.where("user_high", "==", userId).where("read_by_recipient", "==", false).get(),
    ]);
    const out = {};
    const all = [...asLow.docs, ...asHigh.docs];
    for (const d of all) {
      const m = d.data();
      if (!m || m.sender_id === userId) continue;
      out[m.sender_id] = (out[m.sender_id] || 0) + 1;
    }
    return out;
  }

  return {
    mode: "firebase",
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

module.exports = { createFirebaseDb };

