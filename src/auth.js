const crypto = require('crypto');

const COOKIE_NAME = 'admin_session';
const SID_RE = /^[0-9a-f]{32}$/;

function hmacHex(secret, data) {
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
}

const sha256hex = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const newSid = () => crypto.randomBytes(16).toString('hex');

// Token: `${exp}.${sid}.${hmac(exp.sid)}`. The signature stops forgery; the sid
// (stored server-side as a hash) lets logout revoke the session before it expires.
function sign(secret, exp, sid) {
  return `${exp}.${sid}.${hmacHex(secret, `${exp}.${sid}`)}`;
}

// Returns { exp, sid } if the signature is valid and unexpired, else null.
// Does not check revocation; see createAuth().session.
function verify(secret, token, now = Date.now()) {
  if (typeof token !== 'string') return null;
  const m = /^(\d{1,15})\.([0-9a-f]{32})\.([0-9a-f]{64})$/.exec(token);
  if (!m) return null;
  const expected = Buffer.from(hmacHex(secret, `${m[1]}.${m[2]}`), 'hex');
  const given = Buffer.from(m[3], 'hex');
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  const exp = Number(m[1]);
  return exp > now ? { exp, sid: m[2] } : null;
}

function parseCookies(header) {
  const out = {};
  if (typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k || k in out) continue;
    let v = part.slice(i + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
  }
  return out;
}

function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest();
}

// In-memory session store (unit tests / no DB). The app uses the DB-backed one in db.js.
function memoryStore() {
  const live = new Map(); // sidHash -> exp
  return {
    async create(sidHash, exp) { live.set(sidHash, exp); },
    async exists(sidHash, now = Date.now()) { return (live.get(sidHash) || 0) > now; },
    async revoke(sidHash) { live.delete(sidHash); },
  };
}

function createAuth(config, store = memoryStore()) {
  const { SESSION_SECRET, ADMIN_PASSWORD, SESSION_TTL_MS, NODE_ENV } = config;
  const secure = NODE_ENV === 'production' ? ['Secure'] : [];

  function checkPassword(candidate) {
    if (!ADMIN_PASSWORD || typeof candidate !== 'string') return false;
    return crypto.timingSafeEqual(sha256(candidate), sha256(ADMIN_PASSWORD));
  }

  // Signature-only parse of the cookie (no store lookup).
  const parse = (cookieHeader, now = Date.now()) =>
    verify(SESSION_SECRET, parseCookies(cookieHeader)[COOKIE_NAME], now);

  // Valid signature, unexpired, and not revoked -> { exp, sid }; else null.
  async function session(cookieHeader, now = Date.now()) {
    const s = parse(cookieHeader, now);
    if (!s || !SID_RE.test(s.sid)) return null;
    return (await store.exists(sha256hex(s.sid), now)) ? s : null;
  }

  async function setCookie(res) {
    const exp = Date.now() + SESSION_TTL_MS;
    const sid = newSid();
    await store.create(sha256hex(sid), exp);
    res.append('Set-Cookie', [
      `${COOKIE_NAME}=${sign(SESSION_SECRET, exp, sid)}`,
      'HttpOnly', 'SameSite=Strict', 'Path=/',
      `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
      ...secure,
    ].join('; '));
  }

  // Revokes the session named by the cookie (if its signature is valid). Returns its sid or null.
  async function revoke(cookieHeader) {
    const s = parse(cookieHeader);
    if (!s) return null;
    await store.revoke(sha256hex(s.sid));
    return s.sid;
  }

  function clearCookie(res) {
    res.append('Set-Cookie', [
      `${COOKIE_NAME}=`, 'HttpOnly', 'SameSite=Strict', 'Path=/', 'Max-Age=0', ...secure,
    ].join('; '));
  }

  const isAuthed = async (req) => (await session(req.headers.cookie)) !== null;

  return { checkPassword, session, setCookie, revoke, clearCookie, isAuthed };
}

module.exports = { COOKIE_NAME, sign, verify, parseCookies, memoryStore, createAuth, sha256hex };
