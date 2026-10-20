const mysql = require('mysql2/promise');
const { ValidationError } = require('./validate');

function createPool(config) {
  return mysql.createPool({
    host: config.DB_HOST,
    user: config.DB_USER,
    password: config.DB_PASSWORD,
    database: config.DB_NAME,
    port: config.DB_PORT,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
  });
}

async function waitForDb(pool, { retryMs = 5000 } = {}) {
  while (true) {
    try {
      const conn = await pool.getConnection();
      conn.release();
      console.log('Connected to MySQL');
      return;
    } catch (err) {
      console.error(`MySQL not ready, retrying in ${retryMs}ms:`, err.message);
      await new Promise((r) => setTimeout(r, retryMs));
    }
  }
}

const withFlag = (row) => ({ ...row, from_admin: row.sender_name === 'Admin' });

function makeRepo(pool, { PAGE_SIZE_MESSAGES, PAGE_SIZE_ROOMS }) {
  // One builder for list + single-room metadata.
  async function queryRooms({ where = '', params = [], limit = null }) {
    const [rows] = await pool.query(
      `SELECT cr.id, cr.room, cr.sender_name, cr.created,
              m.readMessage AS last_status, m.message AS last_message,
              m.attachment_path AS last_attachment, m.created_at AS last_at
       FROM chat_room cr
       LEFT JOIN messages m ON m.id = (SELECT MAX(id) FROM messages WHERE room = cr.room)
       ${where}
       ORDER BY cr.id DESC
       ${limit ? 'LIMIT ?' : ''}`,
      limit ? [...params, limit] : params
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

  const fetchRooms = ({ beforeId = null } = {}) =>
    queryRooms({
      where: beforeId ? 'WHERE cr.id < ?' : '',
      params: beforeId ? [beforeId] : [],
      limit: PAGE_SIZE_ROOMS,
    });

  const fetchRoomMeta = async (room) =>
    (await queryRooms({ where: 'WHERE cr.room = ?', params: [room] }))[0] || null;

  async function roomExists(room) {
    const [rows] = await pool.query('SELECT 1 FROM chat_room WHERE room = ? LIMIT 1', [room]);
    return rows.length > 0;
  }

  async function fetchMessages({ room, beforeId = null }) {
    const params = [room];
    let where = 'WHERE room = ?';
    if (beforeId) {
      where += ' AND id < ?';
      params.push(beforeId);
    }
    const [rows] = await pool.query(
      `SELECT id, sender_name, message, room, created_at, attachment_path
       FROM messages ${where} ORDER BY id DESC LIMIT ?`,
      [...params, PAGE_SIZE_MESSAGES]
    );
    // Chronological (oldest first) for client-side prepend logic.
    return rows.reverse().map(withFlag);
  }

  async function insertMessage({ sender, message, room, attachmentPath, readStatus }) {
    let result;
    try {
      [result] = await pool.query(
        `INSERT INTO messages (sender_name, message, room, readMessage, attachment_path)
         VALUES (?, ?, ?, ?, ?)`,
        [sender, message || '', room, readStatus, attachmentPath || null]
      );
    } catch (err) {
      // FK messages.room -> chat_room.room: the room does not exist (or was deleted).
      if (err.code === 'ER_NO_REFERENCED_ROW_2') throw new ValidationError('Room not found');
      throw err;
    }
    const [rows] = await pool.query(
      `SELECT id, sender_name, message, room, created_at, attachment_path
       FROM messages WHERE id = ?`,
      [result.insertId]
    );
    return withFlag(rows[0]);
  }

  // Returns true when this call created the room. The token hash is stored in the
  // same INSERT, so a new room is never claimable in between.
  async function ensureRoom({ room, senderName, tokenHash = null }) {
    // UNIQUE KEY on chat_room.room makes this race-safe.
    const [result] = await pool.query(
      'INSERT IGNORE INTO chat_room (room, sender_name, guest_token_hash) VALUES (?, ?, ?)',
      [room, senderName, tokenHash]
    );
    return result.affectedRows > 0;
  }

  // undefined = no such room, null = legacy room without a token.
  async function getTokenHash(room) {
    const [rows] = await pool.query('SELECT guest_token_hash FROM chat_room WHERE room = ? LIMIT 1', [room]);
    return rows.length ? rows[0].guest_token_hash : undefined;
  }

  // Atomic: only one caller can claim a legacy room that has no token yet.
  async function claimLegacyRoom(room, tokenHash) {
    const [result] = await pool.query(
      'UPDATE chat_room SET guest_token_hash = ? WHERE room = ? AND guest_token_hash IS NULL',
      [tokenHash, room]
    );
    return result.affectedRows === 1;
  }

  async function markRoomRead(room) {
    await pool.query(
      "UPDATE messages SET readMessage = 'yes' WHERE room = ? AND readMessage = 'no'",
      [room]
    );
  }

  // Admin sessions (sid hashes only). Expiry in epoch ms to avoid timezone issues.
  const sessionStore = {
    async create(sidHash, exp) {
      await pool.query('DELETE FROM admin_sessions WHERE expires_at <= ?', [Date.now()]);
      await pool.query('INSERT INTO admin_sessions (sid_hash, expires_at) VALUES (?, ?)', [sidHash, exp]);
    },
    async exists(sidHash, now = Date.now()) {
      const [rows] = await pool.query(
        'SELECT 1 FROM admin_sessions WHERE sid_hash = ? AND expires_at > ? LIMIT 1', [sidHash, now]
      );
      return rows.length > 0;
    },
    async revoke(sidHash) {
      await pool.query('DELETE FROM admin_sessions WHERE sid_hash = ?', [sidHash]);
    },
  };

  return {
    fetchRooms, fetchRoomMeta, roomExists, fetchMessages, insertMessage, ensureRoom, getTokenHash,
    claimLegacyRoom, markRoomRead, sessionStore,
  };
}

module.exports = { createPool, waitForDb, makeRepo };
