/**
 * Chat server: guest <-> admin via Socket.IO, persisted in MySQL.
 *
 * Key invariants:
 *   - The DB row (with its auto-increment id) is the single source of truth.
 *     Clients never optimistically render their own messages; they wait for
 *     the server's `message` event echo so every party sees the same id.
 *   - Pagination is cursor-based on `id`, so OFFSET shifting from new inserts
 *     can never duplicate or skip a row.
 *   - Admins join the socket.io room they are actively viewing, so a single
 *     `io.to(room).emit(...)` reaches the guest plus every admin viewing it.
 *     Admins who are not viewing still receive `roomUpdate` for sidebar state.
 */

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs/promises');
const crypto = require('crypto');
const mysql = require('mysql2/promise');
const { Server } = require('socket.io');

// ---------- Config ----------
const PORT = Number(process.env.PORT) || 3000;
const PAGE_SIZE_MESSAGES = 20;
const PAGE_SIZE_ROOMS = 20;
const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB
const ALLOWED_MIME = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
  'application/pdf',
  'text/plain',
  'application/zip',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

// ---------- App / IO ----------
const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 8 * 1024 * 1024 });

app.use(express.static(path.join(__dirname, 'public')));

// ---------- DB ----------
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'db',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || 'root',
  database: process.env.DB_NAME || 'chat',
  port: Number(process.env.DB_PORT) || 3306,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

async function waitForDb() {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const conn = await pool.getConnection();
      conn.release();
      console.log('✅ Connected to MySQL');
      return;
    } catch (err) {
      console.error('MySQL not ready, retrying in 5s:', err.message);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}
waitForDb();

// ---------- Active admin tracking ----------
// socket.id -> currently selected room
const activeAdminRooms = new Map();

// ---------- File upload helper ----------
function safeFilename(originalName) {
  const base = path.basename(String(originalName || 'file'))
    .replace(/[^\w.\-]/g, '_')
    .slice(0, 80) || 'file';
  return `${crypto.randomBytes(8).toString('hex')}-${base}`;
}

async function saveAttachment(file) {
  if (!file || !file.data || !file.name || !file.type) return null;
  if (!ALLOWED_MIME.has(file.type)) {
    throw new Error(`Unsupported file type: ${file.type}`);
  }
  const base64 = String(file.data).split(';base64,').pop();
  const bytes = Buffer.byteLength(base64, 'base64');
  if (bytes > MAX_FILE_BYTES) {
    throw new Error('File too large (max 5 MB)');
  }
  // Note: directory name preserved as 'attachement' (typo in original code)
  // to keep existing URLs in the DB resolvable.
  const uploadDir = path.join(__dirname, 'public', 'attachement');
  await fs.mkdir(uploadDir, { recursive: true });
  const fileName = safeFilename(file.name);
  await fs.writeFile(path.join(uploadDir, fileName), base64, { encoding: 'base64' });
  return `/attachement/${fileName}`;
}

// ---------- Queries ----------
async function fetchRooms({ beforeId = null } = {}) {
  const params = [];
  let where = '';
  if (beforeId) {
    where = 'WHERE cr.id < ?';
    params.push(Number(beforeId));
  }
  const [rows] = await pool.query(
    `SELECT cr.id, cr.room, cr.sender_name, cr.created,
            COALESCE(
              (SELECT m.readMessage FROM messages m
               WHERE m.room = cr.room ORDER BY m.id DESC LIMIT 1), 'yes'
            ) AS last_status,
            (SELECT m.message FROM messages m
             WHERE m.room = cr.room ORDER BY m.id DESC LIMIT 1) AS last_message,
            (SELECT m.attachment_path FROM messages m
             WHERE m.room = cr.room ORDER BY m.id DESC LIMIT 1) AS last_attachment,
            (SELECT m.created_at FROM messages m
             WHERE m.room = cr.room ORDER BY m.id DESC LIMIT 1) AS last_at
     FROM chat_room cr
     ${where}
     ORDER BY cr.id DESC
     LIMIT ?`,
    [...params, PAGE_SIZE_ROOMS]
  );
  return rows.map((r) => ({
    id: r.id,
    room: r.room,
    sender_name: r.sender_name,
    created: r.created,
    last_message: r.last_message,
    last_attachment: r.last_attachment,
    last_at: r.last_at,
    has_unread: r.last_status === 'no',
  }));
}

async function fetchRoomMeta(room) {
  const [rows] = await pool.query(
    `SELECT cr.id, cr.room, cr.sender_name, cr.created,
            COALESCE(
              (SELECT m.readMessage FROM messages m
               WHERE m.room = cr.room ORDER BY m.id DESC LIMIT 1), 'yes'
            ) AS last_status,
            (SELECT m.message FROM messages m
             WHERE m.room = cr.room ORDER BY m.id DESC LIMIT 1) AS last_message,
            (SELECT m.attachment_path FROM messages m
             WHERE m.room = cr.room ORDER BY m.id DESC LIMIT 1) AS last_attachment,
            (SELECT m.created_at FROM messages m
             WHERE m.room = cr.room ORDER BY m.id DESC LIMIT 1) AS last_at
     FROM chat_room cr WHERE cr.room = ?`,
    [room]
  );
  if (!rows[0]) return null;
  const r = rows[0];
  return {
    id: r.id,
    room: r.room,
    sender_name: r.sender_name,
    created: r.created,
    last_message: r.last_message,
    last_attachment: r.last_attachment,
    last_at: r.last_at,
    has_unread: r.last_status === 'no',
  };
}

async function fetchMessages({ room, beforeId = null }) {
  const params = [room];
  let where = 'WHERE room = ?';
  if (beforeId) {
    where += ' AND id < ?';
    params.push(Number(beforeId));
  }
  const [rows] = await pool.query(
    `SELECT id, sender_name, message, room, created_at, attachment_path
     FROM messages
     ${where}
     ORDER BY id DESC
     LIMIT ?`,
    [...params, PAGE_SIZE_MESSAGES]
  );
  // Return chronological asc (oldest first) for easy client-side prepend logic.
  return rows.reverse();
}

async function insertMessage({ sender, message, room, attachmentPath, readStatus }) {
  const [result] = await pool.query(
    `INSERT INTO messages (sender_name, message, room, readMessage, attachment_path)
     VALUES (?, ?, ?, ?, ?)`,
    [sender, message || '', room, readStatus, attachmentPath || null]
  );
  const [rows] = await pool.query(
    `SELECT id, sender_name, message, room, created_at, attachment_path
     FROM messages WHERE id = ?`,
    [result.insertId]
  );
  return rows[0];
}

async function ensureRoom({ room, senderName }) {
  // UNIQUE KEY on chat_room.room makes this race-safe.
  const [result] = await pool.query(
    `INSERT IGNORE INTO chat_room (room, sender_name) VALUES (?, ?)`,
    [room, senderName]
  );
  return result.affectedRows > 0; // true if newly created
}

async function markRoomRead(room) {
  await pool.query(
    `UPDATE messages SET readMessage = 'yes' WHERE room = ? AND readMessage = 'no'`,
    [room]
  );
}

// ---------- Socket handlers ----------
io.on('connection', (socket) => {
  console.log('connect', socket.id);

  // ===== Admin =====
  socket.on('adminConnected', async () => {
    socket.join('admins');
    socket.data.role = 'admin';
    try {
      const rooms = await fetchRooms();
      socket.emit('roomList', { rooms, hasMore: rooms.length === PAGE_SIZE_ROOMS });
    } catch (err) {
      console.error('adminConnected:', err);
      socket.emit('serverError', { message: 'Failed to load rooms' });
    }
  });

  socket.on('adminLoadMoreRooms', async ({ beforeId } = {}) => {
    try {
      const rooms = await fetchRooms({ beforeId });
      socket.emit('roomListAppend', { rooms, hasMore: rooms.length === PAGE_SIZE_ROOMS });
    } catch (err) {
      console.error('adminLoadMoreRooms:', err);
      socket.emit('serverError', { message: 'Failed to load more rooms' });
    }
  });

  socket.on('adminSelectRoom', async ({ room } = {}) => {
    if (!room) return;
    const prev = activeAdminRooms.get(socket.id);
    if (prev && prev !== room) socket.leave(prev);
    activeAdminRooms.set(socket.id, room);
    socket.join(room);
    try {
      const messages = await fetchMessages({ room });
      socket.emit('chatHistory', {
        room,
        messages,
        hasMore: messages.length === PAGE_SIZE_MESSAGES,
      });
      await markRoomRead(room);
      const meta = await fetchRoomMeta(room);
      if (meta) io.to('admins').emit('roomUpdate', meta);
    } catch (err) {
      console.error('adminSelectRoom:', err);
      socket.emit('serverError', { message: 'Failed to load room' });
    }
  });

  socket.on('adminLoadMoreMessages', async ({ room, beforeId } = {}) => {
    if (!room || !beforeId) return;
    try {
      const messages = await fetchMessages({ room, beforeId });
      socket.emit('chatHistoryAppend', {
        room,
        messages,
        hasMore: messages.length === PAGE_SIZE_MESSAGES,
      });
    } catch (err) {
      console.error('adminLoadMoreMessages:', err);
      socket.emit('serverError', { message: 'Failed to load older messages' });
    }
  });

  socket.on('adminMessage', async ({ room, message, file } = {}) => {
    if (!room) return;
    try {
      const attachmentPath = await saveAttachment(file);
      const text = (message || '').toString().trim();
      if (!text && !attachmentPath) return;
      const row = await insertMessage({
        sender: 'Admin',
        message: text,
        room,
        attachmentPath,
        readStatus: 'yes',
      });
      // Reaches guest + every admin viewing this room (admin is in `room`).
      io.to(room).emit('message', row);
      const meta = await fetchRoomMeta(room);
      if (meta) io.to('admins').emit('roomUpdate', meta);
    } catch (err) {
      console.error('adminMessage:', err);
      socket.emit('serverError', { message: err.message || 'Send failed' });
    }
  });

  // ===== Guest =====
  socket.on('guestConnected', async ({ guestName, room } = {}) => {
    const name = (guestName || '').toString().trim().slice(0, 80);
    const r = (room || '').toString().trim().slice(0, 250);
    if (!name || !r) return;
    socket.data.role = 'guest';
    socket.data.guestName = name;
    socket.data.room = r;
    socket.join(r);
    try {
      const created = await ensureRoom({ room: r, senderName: name });
      const messages = await fetchMessages({ room: r });
      socket.emit('chatHistory', {
        room: r,
        messages,
        hasMore: messages.length === PAGE_SIZE_MESSAGES,
      });
      const meta = await fetchRoomMeta(r);
      if (meta) {
        io.to('admins').emit(created ? 'roomNew' : 'roomUpdate', meta);
      }
    } catch (err) {
      console.error('guestConnected:', err);
      socket.emit('serverError', { message: 'Failed to join room' });
    }
  });

  socket.on('guestLoadMoreMessages', async ({ room, beforeId } = {}) => {
    if (!room || !beforeId) return;
    try {
      const messages = await fetchMessages({ room, beforeId });
      socket.emit('chatHistoryAppend', {
        room,
        messages,
        hasMore: messages.length === PAGE_SIZE_MESSAGES,
      });
    } catch (err) {
      console.error('guestLoadMoreMessages:', err);
      socket.emit('serverError', { message: 'Failed to load older messages' });
    }
  });

  socket.on('guestMessage', async ({ message, room, guestName, file } = {}) => {
    const name = (guestName || socket.data.guestName || 'Guest').toString().trim().slice(0, 80);
    const r = (room || socket.data.room || '').toString().trim();
    if (!r) return;
    try {
      const attachmentPath = await saveAttachment(file);
      const text = (message || '').toString().trim();
      if (!text && !attachmentPath) return;
      const isAdminViewing = [...activeAdminRooms.values()].includes(r);
      const row = await insertMessage({
        sender: name,
        message: text,
        room: r,
        attachmentPath,
        readStatus: isAdminViewing ? 'yes' : 'no',
      });
      // Reaches guest (self) + every admin viewing this room.
      io.to(r).emit('message', row);
      // All admins (even those not viewing) get sidebar update.
      const meta = await fetchRoomMeta(r);
      if (meta) io.to('admins').emit('roomUpdate', meta);
    } catch (err) {
      console.error('guestMessage:', err);
      socket.emit('serverError', { message: err.message || 'Send failed' });
    }
  });

  // ===== Disconnect (single handler, no duplicates) =====
  socket.on('disconnect', () => {
    activeAdminRooms.delete(socket.id);
    console.log('disconnect', socket.id);
  });
});

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
