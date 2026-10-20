const path = require('path');
const fs = require('fs/promises');
const crypto = require('crypto');
const { MAX_FILE_BYTES } = require('./config');
const { ValidationError } = require('./validate');

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const ALLOWED = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
  'text/plain': '.txt',
  'application/zip': '.zip',
  'application/x-zip-compressed': '.zip',
  'application/msword': '.doc',
  [DOCX]: '.docx',
  'application/vnd.ms-excel': '.xls',
  [XLSX]: '.xlsx',
};

const ZIP = [0x50, 0x4b, 0x03, 0x04];
const OLE = [0xd0, 0xcf, 0x11, 0xe0];

const startsWith = (buf, sig, offset = 0) =>
  buf.length >= offset + sig.length && sig.every((b, i) => buf[offset + i] === b);

const MAGIC = {
  'image/png': (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47]),
  'image/jpeg': (b) => startsWith(b, [0xff, 0xd8, 0xff]),
  'image/gif': (b) => startsWith(b, [0x47, 0x49, 0x46, 0x38]),
  'image/webp': (b) => startsWith(b, [0x52, 0x49, 0x46, 0x46]) && startsWith(b, [0x57, 0x45, 0x42, 0x50], 8),
  'application/pdf': (b) => startsWith(b, [0x25, 0x50, 0x44, 0x46]),
  'application/zip': (b) => startsWith(b, ZIP),
  'application/x-zip-compressed': (b) => startsWith(b, ZIP),
  [DOCX]: (b) => startsWith(b, ZIP),
  [XLSX]: (b) => startsWith(b, ZIP),
  'application/msword': (b) => startsWith(b, OLE),
  'application/vnd.ms-excel': (b) => startsWith(b, OLE),
  'text/plain': (b) => !b.includes(0),
};

// Decoded size estimated from base64 length, without decoding.
function estimateBase64Bytes(b64) {
  let pad = 0;
  if (b64.endsWith('==')) pad = 2;
  else if (b64.endsWith('=')) pad = 1;
  return Math.floor((b64.length * 3) / 4) - pad;
}

function extractBase64(data) {
  const m = /^data:[^,]*;base64,/i.exec(data);
  return m ? data.slice(m[0].length) : data;
}

function decodeBase64(data, maxBytes = MAX_FILE_BYTES) {
  if (typeof data !== 'string' || !data) throw new ValidationError('Invalid file data');
  const b64 = extractBase64(data);
  if (estimateBase64Bytes(b64) > maxBytes) {
    throw new ValidationError(`File too large (max ${Math.floor(maxBytes / (1024 * 1024))} MB)`);
  }
  if (!b64 || b64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) {
    throw new ValidationError('Invalid file data');
  }
  return Buffer.from(b64, 'base64');
}

function sanitizeBase(name) {
  const base = path.parse(path.basename(String(name || ''))).name
    .replace(/[^\w-]/g, '_')
    .slice(0, 40);
  return base || 'file';
}

function buildFilename(name, ext, rand = crypto.randomBytes(8).toString('hex')) {
  return `${rand}-${sanitizeBase(name)}${ext}`;
}

// Returns { buffer, ext, mime, name } or null when no file was sent.
function validateAttachment(file, { maxBytes = MAX_FILE_BYTES } = {}) {
  if (file === undefined || file === null) return null;
  if (typeof file !== 'object' || typeof file.type !== 'string' || typeof file.data !== 'string') {
    throw new ValidationError('Invalid file');
  }
  const ext = Object.hasOwn(ALLOWED, file.type) ? ALLOWED[file.type] : null;
  if (!ext) throw new ValidationError('Unsupported file type');
  const buffer = decodeBase64(file.data, maxBytes);
  if (!MAGIC[file.type](buffer)) throw new ValidationError('File content does not match its type');
  return { buffer, ext, mime: file.type, name: sanitizeBase(file.name) };
}

// Total size of the regular files directly inside `dir` (non-recursive). Missing dir = 0.
async function dirSize(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return 0;
    throw err;
  }
  let total = 0;
  for (const e of entries) {
    if (!e.isFile()) continue;
    try {
      total += (await fs.stat(path.join(dir, e.name))).size;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err; // deleted meanwhile
    }
  }
  return total;
}

// Running total of bytes in the upload dir, computed once at startup.
// In-memory and single-instance: deletions made outside the process (e.g. the
// prune script) are only picked up after a restart.
function createUploadQuota({ dir, maxBytes }) {
  let used = 0;
  const ready = dirSize(dir).then((n) => { used += n; });
  // A scan failure must not crash startup or reject every save: treat as empty.
  const safeReady = ready.catch((err) => console.error('upload quota scan failed:', err.message));
  return {
    ready: safeReady,
    used: () => used,
    maxBytes,
    // Reserves `bytes`; throws when the quota would be exceeded.
    async reserve(bytes) {
      await safeReady;
      if (used + bytes > maxBytes) throw new ValidationError('Upload storage is full');
      used += bytes;
    },
    release(bytes) { used = Math.max(0, used - bytes); },
  };
}

// Note: URL path 'attachement' (sic) kept so old DB URLs still resolve.
async function saveAttachment(file, dir, quota = null) {
  const v = validateAttachment(file);
  if (!v) return null;
  if (quota) await quota.reserve(v.buffer.length);
  try {
    await fs.mkdir(dir, { recursive: true });
    const fileName = buildFilename(file.name, v.ext);
    await fs.writeFile(path.join(dir, fileName), v.buffer, { flag: 'wx' });
    return `/attachement/${fileName}`;
  } catch (err) {
    if (quota) quota.release(v.buffer.length);
    throw err;
  }
}

module.exports = {
  ALLOWED, MAGIC, estimateBase64Bytes, decodeBase64, sanitizeBase, buildFilename,
  validateAttachment, saveAttachment, dirSize, createUploadQuota,
};
