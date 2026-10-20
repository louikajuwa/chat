const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startServer, emitAck, newRoom } = require('../helpers');

let ctx;
test.before(async () => { ctx = await startServer(); });
test.after(async () => { await ctx.close(); });

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

async function sendFile(file) {
  const s = await ctx.connect();
  await emitAck(s, 'guestConnected', { guestName: 'Up', room: newRoom() });
  const got = new Promise((resolve) => s.once('message', resolve));
  const ack = await emitAck(s, 'guestMessage', { message: '', file });
  if (!ack.ok) return { ack };
  const msg = await got;
  return { ack, msg };
}

test('valid png is saved with random name and served inline with nosniff', async () => {
  const { ack, msg } = await sendFile({ name: '../../My Pic.png', type: 'image/png', data: `data:image/png;base64,${PNG.toString('base64')}` });
  assert.equal(ack.ok, true);
  assert.match(msg.attachment_path, /^\/attachement\/[0-9a-f]{16}-My_Pic\.png$/);
  const onDisk = fs.readFileSync(path.join(ctx.uploadDir, path.basename(msg.attachment_path)));
  assert.deepEqual(onDisk, PNG);

  const res = await fetch(ctx.url + msg.attachment_path);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('content-security-policy'), "sandbox; default-src 'none'");
  assert.equal(res.headers.get('content-disposition'), null);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), PNG);
});

test('text file named .html gets .txt, served as attachment', async () => {
  const { msg } = await sendFile({ name: 'evil.html', type: 'text/plain', data: Buffer.from('<script>alert(1)</script>').toString('base64') });
  assert.match(msg.attachment_path, /-evil\.txt$/);
  const res = await fetch(ctx.url + msg.attachment_path);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /^attachment/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.match(res.headers.get('content-security-policy'), /sandbox/);
});

test('pdf is served as attachment', async () => {
  const { msg } = await sendFile({ name: 'doc.pdf', type: 'application/pdf', data: Buffer.from('%PDF-1.4 test').toString('base64') });
  const res = await fetch(ctx.url + msg.attachment_path);
  assert.match(res.headers.get('content-disposition'), /^attachment/);
});

test('encoded-slash path to an attachment still gets protective headers', async () => {
  const { msg } = await sendFile({ name: 'doc.pdf', type: 'application/pdf', data: Buffer.from('%PDF-1.4 test').toString('base64') });
  const res = await fetch(ctx.url + msg.attachment_path.replace('/attachement/', '/attachement%2F'));
  if (res.status === 200) {
    assert.match(res.headers.get('content-disposition'), /^attachment/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  }
});

test('spoofed content is rejected and nothing is written', async () => {
  const before = fs.readdirSync(ctx.uploadDir).length;
  const { ack } = await sendFile({ name: 'x.png', type: 'image/png', data: Buffer.from('<html>').toString('base64') });
  assert.deepEqual(ack, { ok: false, error: 'File content does not match its type' });
  assert.equal(fs.readdirSync(ctx.uploadDir).length, before);
});

test('unsupported type, oversize and bad base64 are rejected', async () => {
  assert.equal((await sendFile({ name: 'a.html', type: 'text/html', data: 'aGk=' })).ack.error, 'Unsupported file type');
  const big = Buffer.alloc(5 * 1024 * 1024 + 1);
  PNG.copy(big);
  const r = await sendFile({ name: 'big.png', type: 'image/png', data: big.toString('base64') });
  assert.equal(r.ack.error, 'File too large (max 5 MB)');
  assert.equal((await sendFile({ name: 'a.png', type: 'image/png', data: '***' })).ack.error, 'Invalid file data');
});

test('dotfiles and directory listing are not served', async () => {
  assert.equal((await fetch(ctx.url + '/attachement/.gitkeep')).status, 404);
  assert.equal((await fetch(ctx.url + '/attachement/')).status, 404);
});
