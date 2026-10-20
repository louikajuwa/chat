const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startServer, emitAck, newRoom } = require('../helpers');
const { createUploadQuota } = require('../../src/attachments');

const txt = (n, name = 'a.txt') => ({ name, type: 'text/plain', data: Buffer.alloc(n, 97).toString('base64') });

test('/attachement is served from UPLOAD_DIR; legacy public/attachement files are not served', async () => {
  const ctx = await startServer();
  try {
    const name = 'aaaaaaaaaaaaaaaa-direct.txt';
    fs.writeFileSync(path.join(ctx.uploadDir, name), 'hello');
    const res = await fetch(`${ctx.url}/attachement/${name}`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'hello');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.match(res.headers.get('content-disposition'), /^attachment/);

    const legacyDir = path.join(__dirname, '..', '..', 'public', 'attachement');
    const legacy = fs.readdirSync(legacyDir).filter((f) => !f.startsWith('.'));
    for (const f of [...legacy, 'nonexistent.png']) {
      const e = encodeURIComponent(f);
      for (const url of [`/attachement/${e}`, `/attachement%2F${e}`, `/public/attachement/${e}`]) {
        assert.equal((await fetch(ctx.url + url)).status, 404, url);
      }
    }
    assert.equal((await fetch(`${ctx.url}/ATTACHEMENT%2f${name}`)).status, 404);
  } finally {
    await ctx.close();
  }
});

test('upload quota: exceeding it is rejected with a clear error and nothing is written', async () => {
  const ctx = await startServer({ MAX_UPLOAD_DIR_BYTES: 400 });
  try {
    await ctx.quota.ready;
    const s = await ctx.connect();
    await emitAck(s, 'guestConnected', { guestName: 'Q', room: newRoom() });
    assert.deepEqual(await emitAck(s, 'guestMessage', { message: '', file: txt(450) }), { ok: false, error: 'Upload storage is full' });
    assert.deepEqual(fs.readdirSync(ctx.uploadDir), []);
    assert.equal(ctx.quota.used(), 0);
    // A file that fits is accepted and consumes quota; the next one no longer fits.
    assert.equal((await emitAck(s, 'guestMessage', { message: '', file: txt(300) })).ok, true);
    assert.equal(ctx.quota.used(), 300);
    assert.equal((await emitAck(s, 'guestMessage', { message: '', file: txt(300) })).error, 'Upload storage is full');
    assert.equal(fs.readdirSync(ctx.uploadDir).length, 1);
  } finally {
    await ctx.close();
  }
});

test('upload quota counts files already in UPLOAD_DIR at startup (non-recursive)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-'));
  try {
    fs.writeFileSync(path.join(dir, 'a'), Buffer.alloc(100));
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'sub', 'b'), Buffer.alloc(1000));
    const q = createUploadQuota({ dir, maxBytes: 150 });
    await q.ready;
    assert.equal(q.used(), 100);
    await assert.rejects(q.reserve(51), /Upload storage is full/);
    await q.reserve(50);
    assert.equal(q.used(), 150);
    q.release(50);
    assert.equal(q.used(), 100);
    const missing = createUploadQuota({ dir: path.join(dir, 'missing'), maxBytes: 1 });
    await missing.ready;
    assert.equal(missing.used(), 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
