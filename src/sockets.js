/**
 * Socket.IO handlers.
 *
 * Invariants:
 *   - The DB row (auto-increment id) is the source of truth; clients render
 *     the server's `message` echo, never their own optimistic copy.
 *   - Pagination is cursor-based on `id`.
 *   - Guests only ever act on socket.data.room / socket.data.guestName (set by
 *     a validated guestConnected); client-supplied values are ignored.
 *   - Admin events require a valid admin_session cookie seen at handshake.
 */
const crypto = require('crypto');
const { createLimiter } = require('./rateLimit');
const { saveAttachment } = require('./attachments');
const { socketIp } = require('./clientIp');
const v = require('./validate');

const sha256hex = (s) => crypto.createHash('sha256').update(s).digest('hex');
const TOKEN_RE = /^[0-9a-f]{64}$/;
const newToken = () => crypto.randomBytes(32).toString('hex');

// Constant-time check of a client token against the stored sha256 hex hash.
function tokenMatches(token, storedHash) {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return false;
  if (typeof storedHash !== 'string' || !TOKEN_RE.test(storedHash)) return false;
  return crypto.timingSafeEqual(Buffer.from(sha256hex(token), 'hex'), Buffer.from(storedHash, 'hex'));
}

/**
 * Abuse limits are in memory, per IP, per process: they only hold for a single
 * app instance (multiple instances would each keep their own counters).
 */
function attachSockets(io, { repo, config, auth, quota = null }) {
  const attachmentsDir = config.UPLOAD_DIR;
  const { PAGE_SIZE_MESSAGES } = config;
  const adminRooms = new Map(); // socket.id -> room being viewed
  const viewerCount = new Map(); // room -> number of admins viewing
  const socketsPerIp = new Map(); // ip -> open connections
  const roomLimiter = createLimiter({ limit: config.ROOMS_PER_IP, windowMs: config.ROOMS_WINDOW_MS });
  const ipMessageLimiter = createLimiter({ limit: config.MESSAGES_PER_IP, windowMs: config.MESSAGES_WINDOW_MS });
  const pruneTimer = setInterval(() => {
    roomLimiter.prune();
    ipMessageLimiter.prune();
  }, 60 * 1000);
  pruneTimer.unref();
  if (io.httpServer) io.httpServer.on('close', () => clearInterval(pruneTimer));

  const isAdmin = (socket) => socket.data.adminExp > Date.now();

  function setViewing(socket, room) {
    const prev = adminRooms.get(socket.id);
    if (prev === room) return;
    if (prev) {
      socket.leave(prev);
      const n = (viewerCount.get(prev) || 1) - 1;
      if (n > 0) viewerCount.set(prev, n); else viewerCount.delete(prev);
      adminRooms.delete(socket.id);
    }
    if (room) {
      adminRooms.set(socket.id, room);
      viewerCount.set(room, (viewerCount.get(room) || 0) + 1);
      socket.join(room);
    }
  }

  // Per-IP connection cap. The engine connection's 'close' fires for every
  // connection (even one that never completes the handshake), so counters can't leak.
  io.use((socket, next) => {
    const ip = socketIp(socket, config.TRUST_PROXY);
    socket.data.ip = ip;
    const open = socketsPerIp.get(ip) || 0;
    if (open >= config.MAX_SOCKETS_PER_IP) return next(new Error('Too many connections'));
    socketsPerIp.set(ip, open + 1);
    socket.conn.once('close', () => {
      const n = (socketsPerIp.get(ip) || 1) - 1;
      if (n > 0) socketsPerIp.set(ip, n); else socketsPerIp.delete(ip);
    });
    return next();
  });

  // Never reject on auth: guests share this server.
  io.use(async (socket, next) => {
    try {
      const s = await auth.session(socket.handshake.headers.cookie);
      if (s) {
        socket.data.adminExp = s.exp;
        socket.data.adminSid = s.sid;
      }
    } catch (err) {
      console.error('session check:', err.message); // treat as guest
    }
    next();
  });

  function dropAdmin(socket) {
    socket.data.adminExp = 0;
    socket.leave('admins');
    setViewing(socket, null);
    socket.emit('unauthorized');
  }

  io.on('connection', (socket) => {
    // Drop admin privileges the moment the session cookie expires, not just on the next event.
    let expiryTimer = null;
    if (isAdmin(socket)) {
      expiryTimer = setTimeout(() => dropAdmin(socket), socket.data.adminExp - Date.now());
    }

    const msgLimiter = createLimiter({ limit: 10, windowMs: 10000 });
    const otherLimiter = createLimiter({ limit: 30, windowMs: 10000 });

    // Registers an event with ack handling, authz, rate limiting and error mapping.
    function on(event, { admin = false, isMessage = false } = {}, handler) {
      socket.on(event, async (...args) => {
        const ack = typeof args[args.length - 1] === 'function' ? args.pop() : null;
        const fail = (error, extra = {}) => {
          if (ack) ack({ ok: false, error, ...extra });
          else socket.emit('serverError', { message: error });
        };
        if (admin && !isAdmin(socket)) {
          socket.leave('admins');
          if (ack) ack({ ok: false, error: 'Unauthorized', code: 'UNAUTHORIZED' });
          socket.emit('unauthorized');
          return;
        }
        const limiter = isMessage ? msgLimiter : otherLimiter;
        if (!limiter.hit()) return fail('Too many requests, slow down');
        // Aggregate per-IP cap across all of that IP's sockets (guests only).
        if (isMessage && !admin && !ipMessageLimiter.hit(socket.data.ip)) {
          return fail('Too many requests, slow down');
        }
        try {
          const extra = await handler(v.payload(args[0]));
          if (ack) ack({ ok: true, ...(extra || {}) });
        } catch (err) {
          if (err instanceof v.ValidationError) return fail(err.message);
          console.error(`${event}:`, err);
          fail('Something went wrong');
        }
      });
    }

    const sendHistory = (eventName, room, messages) =>
      socket.emit(eventName, { room, messages, hasMore: messages.length === PAGE_SIZE_MESSAGES });

    async function requireAdminRoom(raw) {
      const room = v.adminRoom(raw);
      if (!(await repo.roomExists(room))) throw new v.ValidationError('Room not found');
      return room;
    }

    async function broadcastMeta(room) {
      const meta = await repo.fetchRoomMeta(room);
      if (meta) io.to('admins').emit('roomUpdate', meta);
    }

    // ===== Admin =====
    on('adminConnected', { admin: true }, async () => {
      socket.join('admins');
      socket.data.role = 'admin';
      const rooms = await repo.fetchRooms();
      socket.emit('roomList', { rooms, hasMore: rooms.length === config.PAGE_SIZE_ROOMS });
    });

    on('adminLoadMoreRooms', { admin: true }, async ({ beforeId }) => {
      const rooms = await repo.fetchRooms({ beforeId: v.beforeId(beforeId) });
      socket.emit('roomListAppend', { rooms, hasMore: rooms.length === config.PAGE_SIZE_ROOMS });
    });

    on('adminSelectRoom', { admin: true }, async ({ room: rawRoom }) => {
      const room = await requireAdminRoom(rawRoom);
      setViewing(socket, room);
      sendHistory('chatHistory', room, await repo.fetchMessages({ room }));
      await repo.markRoomRead(room);
      await broadcastMeta(room);
    });

    on('adminLoadMoreMessages', { admin: true }, async ({ room: rawRoom, beforeId }) => {
      const room = await requireAdminRoom(rawRoom);
      const before = v.beforeId(beforeId, { required: true });
      sendHistory('chatHistoryAppend', room, await repo.fetchMessages({ room, beforeId: before }));
    });

    on('adminMessage', { admin: true, isMessage: true }, async ({ room: rawRoom, message, file }) => {
      const room = await requireAdminRoom(rawRoom);
      const text = v.message(message);
      const attachmentPath = await saveAttachment(file, attachmentsDir, quota);
      if (!text && !attachmentPath) throw new v.ValidationError('Message is empty');
      const row = await repo.insertMessage({
        sender: 'Admin', message: text, room, attachmentPath, readStatus: 'yes',
      });
      io.to(room).emit('message', row);
      await broadcastMeta(room);
    });

    // ===== Guest =====
    // The room id alone is not enough to resume a chat: a per-room secret token
    // (only its sha256 is stored) is required. Every failure is 'Invalid room' so
    // a wrong token is indistinguishable from a malformed or unknown id.
    // Returns { created, token } where token is set only when the server issued it.
    // Current clients generate their own token before the first join, so a retry
    // after a lost ack still matches; older clients without one get a server token.
    async function admitGuest(room, name, token) {
      const own = typeof token === 'string' && TOKEN_RE.test(token) ? token : null;
      const issue = () => own || newToken();
      let hash = await repo.getTokenHash(room);
      if (hash === undefined) {
        if (!roomLimiter.hit(socket.data.ip)) throw new v.ValidationError('Too many new chats, try again later');
        const fresh = issue();
        if (await repo.ensureRoom({ room, senderName: name, tokenHash: sha256hex(fresh) })) {
          return { created: true, token: own ? null : fresh };
        }
        hash = await repo.getTokenHash(room); // lost a creation race
      }
      if (hash === null) { // legacy room without a token: first claimant wins
        const fresh = issue();
        if (await repo.claimLegacyRoom(room, sha256hex(fresh))) return { created: false, token: own ? null : fresh };
        hash = await repo.getTokenHash(room);
      }
      if (!tokenMatches(token, hash)) throw new v.ValidationError('Invalid room');
      return { created: false, token: null };
    }

    on('guestConnected', {}, async ({ guestName, room: rawRoom, token }) => {
      const room = v.guestRoom(rawRoom);
      const name = v.guestName(guestName);
      const admitted = await admitGuest(room, name, token);
      const prev = socket.data.room;
      if (prev && prev !== room) socket.leave(prev);
      socket.data.role = 'guest';
      socket.data.guestName = name;
      socket.data.room = room;
      socket.join(room);
      sendHistory('chatHistory', room, await repo.fetchMessages({ room }));
      const meta = await repo.fetchRoomMeta(room);
      if (meta) io.to('admins').emit(admitted.created ? 'roomNew' : 'roomUpdate', meta);
      return admitted.token ? { token: admitted.token } : undefined;
    });

    on('guestLoadMoreMessages', {}, async ({ beforeId }) => {
      const room = socket.data.room;
      if (socket.data.role !== 'guest' || !room) throw new v.ValidationError('Not in a room');
      const before = v.beforeId(beforeId, { required: true });
      sendHistory('chatHistoryAppend', room, await repo.fetchMessages({ room, beforeId: before }));
    });

    on('guestMessage', { isMessage: true }, async ({ message, file }) => {
      const room = socket.data.room;
      if (socket.data.role !== 'guest' || !room) throw new v.ValidationError('Not in a room');
      const text = v.message(message);
      const attachmentPath = await saveAttachment(file, attachmentsDir, quota);
      if (!text && !attachmentPath) throw new v.ValidationError('Message is empty');
      const row = await repo.insertMessage({
        sender: socket.data.guestName,
        message: text,
        room,
        attachmentPath,
        readStatus: viewerCount.get(room) > 0 ? 'yes' : 'no',
      });
      io.to(room).emit('message', row);
      await broadcastMeta(room);
    });

    socket.on('disconnect', () => {
      clearTimeout(expiryTimer);
      setViewing(socket, null);
    });
  });

  // Called on logout: live sockets of that session lose admin rights immediately.
  function revokeSession(sid) {
    for (const socket of io.of('/').sockets.values()) {
      if (socket.data.adminSid === sid) dropAdmin(socket);
    }
  }

  return { revokeSession };
}

module.exports = { attachSockets };
