const { MAX_MESSAGE_LEN, MAX_NAME_LEN, MAX_ROOM_LEN } = require('./config');

// Errors of this type are safe to show to clients; everything else is generic.
class ValidationError extends Error {}

const ROOM_RE = /^room-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function payload(p) {
  return p && typeof p === 'object' && !Array.isArray(p) ? p : {};
}

function guestRoom(v) {
  const room = typeof v === 'string' ? v.trim() : '';
  if (!ROOM_RE.test(room)) throw new ValidationError('Invalid room');
  return room;
}

// Legacy rooms may not match the strict format; existence in chat_room is the real guard.
function adminRoom(v) {
  const room = typeof v === 'string' ? v.trim() : '';
  if (!room || room.length > MAX_ROOM_LEN) throw new ValidationError('Invalid room');
  return room;
}

function guestName(v) {
  const name = typeof v === 'string' ? v.trim() : '';
  if (!name || name.length > MAX_NAME_LEN) throw new ValidationError('Invalid name');
  if (name.toLowerCase() === 'admin') throw new ValidationError('That name is reserved');
  return name;
}

function message(v) {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') throw new ValidationError('Invalid message');
  const text = v.trim();
  if (text.length > MAX_MESSAGE_LEN) {
    throw new ValidationError(`Message too long (max ${MAX_MESSAGE_LEN} characters)`);
  }
  return text;
}

function beforeId(v, { required = false } = {}) {
  if (v === undefined || v === null) {
    if (required) throw new ValidationError('Invalid beforeId');
    return null;
  }
  const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v;
  if (!Number.isSafeInteger(n) || n <= 0) throw new ValidationError('Invalid beforeId');
  return n;
}

module.exports = { ValidationError, ROOM_RE, payload, guestRoom, adminRoom, guestName, message, beforeId };
