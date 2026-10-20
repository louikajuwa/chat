const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const { createAuth } = require('./auth');
const { makeRepo } = require('./db');
const { createLimiter } = require('./rateLimit');
const { attachSockets } = require('./sockets');
const { createUploadQuota } = require('./attachments');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const INLINE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

const CSP = [
  "default-src 'self'",
  "script-src 'self' https://cdn.tailwindcss.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "connect-src 'self' ws: wss:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', CSP);
  next();
}

function createApp({ pool, config, quota = createUploadQuota({ dir: config.UPLOAD_DIR, maxBytes: config.MAX_UPLOAD_DIR_BYTES }) }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.TRUST_PROXY || false);
  const server = http.createServer(app);
  const io = new Server(server, { maxHttpBufferSize: 8 * 1024 * 1024 });
  const repo = makeRepo(pool, config);
  const auth = createAuth(config, repo.sessionStore);
  let sockets = null; // set below; logout uses it to kick the revoked session's live sockets
  const loginLimiter = createLimiter({ limit: config.LOGIN_MAX_ATTEMPTS, windowMs: config.LOGIN_WINDOW_MS });

  app.use(securityHeaders);

  app.get('/healthz', async (req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ status: 'ok' });
    } catch (err) {
      console.error('healthz:', err.message);
      res.status(503).json({ status: 'error' });
    }
  });

  // ---- Admin auth ----
  const bodyParsers = [express.urlencoded({ extended: false, limit: '10kb' }), express.json({ limit: '10kb' })];
  const wantsJson = (req) => /application\/json/i.test(req.get('accept') || '');

  app.post('/admin/login', bodyParsers, async (req, res, next) => {
    try {
      const json = wantsJson(req);
      if (!loginLimiter.hit(req.ip)) {
        return json ? res.status(429).json({ ok: false }) : res.redirect(303, '/login.html?error=rate');
      }
      const password = req.body && req.body.password;
      if (!auth.checkPassword(password)) {
        return json ? res.status(401).json({ ok: false }) : res.redirect(303, '/login.html?error=invalid');
      }
      await auth.setCookie(res);
      return json ? res.json({ ok: true }) : res.redirect(303, '/admin.html');
    } catch (err) {
      return next(err);
    }
  });

  // Revokes the session server-side, so a copied cookie stops working too.
  app.post('/admin/logout', async (req, res, next) => {
    try {
      const sid = await auth.revoke(req.headers.cookie);
      if (sid && sockets) sockets.revokeSession(sid);
      auth.clearCookie(res);
      res.redirect(303, '/login.html');
    } catch (err) {
      next(err);
    }
  });

  // Gate on the decoded, normalized path so %61dmin.html etc. can't reach static.
  app.use(async (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    let p;
    try { p = path.posix.normalize(decodeURIComponent(req.path)).toLowerCase(); } catch { return next(); }
    p = p.replace(/\/+$/, '');
    if (p !== '/admin' && p !== '/admin.html') return next();
    try {
      if (!(await auth.isAuthed(req))) return res.redirect(302, '/login.html');
    } catch (err) {
      return next(err);
    }
    res.setHeader('Cache-Control', 'no-store');
    return res.sendFile(path.join(PUBLIC_DIR, 'admin.html'), { cacheControl: false });
  });

  // ---- Static ----
  // Uploads live in UPLOAD_DIR (a volume), served under the historical URL /attachement/.
  function attachmentHeaders(res, filePath) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
    if (!INLINE_EXT.has(path.extname(filePath).toLowerCase())) {
      res.setHeader('Content-Disposition', 'attachment');
    }
  }
  app.use('/attachement', express.static(config.UPLOAD_DIR, {
    dotfiles: 'ignore', index: false, setHeaders: attachmentHeaders,
  }));
  // public/attachement holds legacy leftovers only: never serve it. Checked on the
  // decoded path so /attachement%2Ffoo can't slip past the mount above into public/.
  app.use((req, res, next) => {
    let p;
    try { p = path.posix.normalize(decodeURIComponent(req.path)).toLowerCase(); } catch { return next(); }
    if (p === '/attachement' || p.startsWith('/attachement/')) return res.status(404).end();
    return next();
  });
  app.use(express.static(PUBLIC_DIR, { dotfiles: 'ignore' }));

  sockets = attachSockets(io, { repo, config, auth, quota });

  return { app, server, io, quota };
}

module.exports = { createApp, CSP };
