const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const mysql = require('mysql2/promise');
const { io: ioClient } = require('socket.io-client');
const { loadConfig } = require('../src/config');
const { createPool } = require('../src/db');
const { createApp } = require('../src/app');

const DB_NAME = process.env.DB_NAME || '';
if (!DB_NAME.endsWith('_test')) {
  throw new Error(`Refusing to run tests: DB_NAME must end with "_test" (got "${DB_NAME}")`);
}

const ADMIN_PASSWORD = 'test-pass';

function dbConfig() {
  return loadConfig(process.env, { ADMIN_PASSWORD, SESSION_SECRET: 'test-secret' });
}

// Creates chat_test and recreates its tables from chat.sql -- only ever touches DB_NAME.
async function setupDb(config) {
  const root = await mysql.createConnection({
    host: config.DB_HOST, user: config.DB_USER, password: config.DB_PASSWORD, port: config.DB_PORT,
  });
  await root.query(`CREATE DATABASE IF NOT EXISTS \`${config.DB_NAME}\``);
  await root.end();
  const conn = await mysql.createConnection({
    host: config.DB_HOST, user: config.DB_USER, password: config.DB_PASSWORD, port: config.DB_PORT,
    database: config.DB_NAME, multipleStatements: true,
  });
  // Fresh schema every time (messages has an FK to chat_room): drop, then apply chat.sql as-is.
  await conn.query('DROP TABLE IF EXISTS messages, chat_room, schema_migrations, admin_sessions');
  await conn.query(fs.readFileSync(path.join(__dirname, '..', 'chat.sql'), 'utf8'));
  await conn.end();
}

async function startServer(overrides = {}) {
  // Every server gets its own throwaway upload dir (os.tmpdir() is writable by the node user)
  // and generous per-IP limits (all test clients share 127.0.0.1); tests lower them via overrides.
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-uploads-'));
  const config = {
    ...dbConfig(),
    LOGIN_MAX_ATTEMPTS: 1000,
    UPLOAD_DIR: uploadDir,
    MAX_SOCKETS_PER_IP: 1000,
    ROOMS_PER_IP: 1000,
    MESSAGES_PER_IP: 100000,
    ...overrides,
  };
  await setupDb(config);
  const pool = createPool(config);
  const { app, server, io, quota } = createApp({ pool, config });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const sockets = [];
  return {
    app, server, io, pool, config, url, quota, uploadDir,
    connect(opts) {
      const s = connectClient(url, opts);
      sockets.push(s);
      return s.ready.then(() => s);
    },
    async close() {
      sockets.forEach((s) => s.close());
      await io.close();
      await pool.end();
      fs.rmSync(uploadDir, { recursive: true, force: true });
    },
  };
}

function connectClient(url, { cookie } = {}) {
  const socket = ioClient(url, {
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
    extraHeaders: cookie ? { Cookie: cookie } : {},
  });
  socket.ready = new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
  return socket;
}

async function adminLogin(url, password = ADMIN_PASSWORD) {
  const res = await fetch(`${url}/admin/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password }),
  });
  const setCookie = res.headers.get('set-cookie');
  const cookie = setCookie ? setCookie.split(';')[0] : null;
  return { res, cookie };
}

function emitAck(socket, event, payload, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`ack timeout for ${event}`)), timeoutMs);
    socket.emit(event, payload, (reply) => {
      clearTimeout(t);
      resolve(reply);
    });
  });
}

function waitFor(socket, event, pred = () => true, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`timeout waiting for ${event}`));
    }, timeoutMs);
    function handler(data) {
      if (!pred(data)) return;
      clearTimeout(t);
      socket.off(event, handler);
      resolve(data);
    }
    socket.on(event, handler);
  });
}

const newRoom = () => `room-${crypto.randomUUID()}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = {
  ADMIN_PASSWORD, startServer, connectClient, adminLogin, emitAck, waitFor, newRoom, sleep,
};
