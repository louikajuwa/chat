const crypto = require('crypto');
const path = require('path');

const constants = {
  SESSION_TTL_MS: 12 * 60 * 60 * 1000,
  PAGE_SIZE_MESSAGES: 20,
  PAGE_SIZE_ROOMS: 20,
  MAX_FILE_BYTES: 5 * 1024 * 1024,
  MAX_MESSAGE_LEN: 5000,
  MAX_NAME_LEN: 80,
  MAX_ROOM_LEN: 250,
};

function positiveInt(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

// Reads env once; `warnings` are logged by the bootstrap (server.js).
function loadConfig(env = process.env, overrides = {}) {
  const warnings = [];
  const ADMIN_PASSWORD = env.ADMIN_PASSWORD || '';
  let SESSION_SECRET = env.SESSION_SECRET || '';
  if (!ADMIN_PASSWORD) {
    warnings.push('ADMIN_PASSWORD is not set: admin login is disabled');
  }
  if (!SESSION_SECRET) {
    SESSION_SECRET = crypto.randomBytes(32).toString('hex');
    warnings.push('SESSION_SECRET is not set: using a random per-process secret (sessions reset on restart)');
  }
  return {
    ...constants,
    NODE_ENV: env.NODE_ENV || 'development',
    PORT: Number(env.PORT) || 3000,
    DB_HOST: env.DB_HOST || 'db',
    // No root fallback: compose always sets the least-privilege chat_app credentials.
    DB_USER: env.DB_USER || 'chat_app',
    DB_PASSWORD: env.DB_PASSWORD || '',
    DB_NAME: env.DB_NAME || 'chat',
    DB_PORT: Number(env.DB_PORT) || 3306,
    UPLOAD_DIR: env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads'),
    // '1'/'true' = trust one proxy hop (X-Forwarded-For); anything else = do not trust.
    TRUST_PROXY: /^(1|true)$/i.test(env.TRUST_PROXY || '') ? 1 : false,
    // In-memory abuse limits: per process, per IP (single instance only).
    MAX_SOCKETS_PER_IP: positiveInt(env.MAX_SOCKETS_PER_IP, 20),
    ROOMS_PER_IP: positiveInt(env.ROOMS_PER_IP, 10),
    ROOMS_WINDOW_MS: 10 * 60 * 1000,
    MESSAGES_PER_IP: positiveInt(env.MESSAGES_PER_IP, 30),
    MESSAGES_WINDOW_MS: 10 * 1000,
    MAX_UPLOAD_DIR_BYTES: positiveInt(env.MAX_UPLOAD_DIR_BYTES, 1024 * 1024 * 1024),
    ADMIN_PASSWORD,
    SESSION_SECRET,
    LOGIN_MAX_ATTEMPTS: positiveInt(env.LOGIN_MAX_ATTEMPTS, 5),
    LOGIN_WINDOW_MS: 60 * 1000,
    warnings,
    ...overrides,
  };
}

module.exports = { loadConfig, ...constants };
