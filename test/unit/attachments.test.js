const test = require('node:test');
const assert = require('node:assert/strict');
const a = require('../../src/attachments');
const { ValidationError } = require('../../src/validate');

const b64 = (buf) => Buffer.from(buf).toString('base64');
const pad = (head, n = 32) => Buffer.concat([Buffer.from(head), Buffer.alloc(n)]);
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const samples = [
  ['image/png', '.png', pad([0x89, 0x50, 0x4e, 0x47])],
  ['image/jpeg', '.jpg', pad([0xff, 0xd8, 0xff, 0xe0])],
  ['image/gif', '.gif', pad('GIF89a')],
  ['image/webp', '.webp', Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(8)])],
  ['application/pdf', '.pdf', pad('%PDF-1.7')],
  ['text/plain', '.txt', Buffer.from('hello world\n')],
  ['application/zip', '.zip', pad([0x50, 0x4b, 0x03, 0x04])],
  ['application/x-zip-compressed', '.zip', pad([0x50, 0x4b, 0x03, 0x04])],
  [DOCX, '.docx', pad([0x50, 0x4b, 0x03, 0x04])],
  [XLSX, '.xlsx', pad([0x50, 0x4b, 0x03, 0x04])],
  ['application/msword', '.doc', pad([0xd0, 0xcf, 0x11, 0xe0])],
  ['application/vnd.ms-excel', '.xls', pad([0xd0, 0xcf, 0x11, 0xe0])],
];

for (const [type, ext, buf] of samples) {
  test(`accepts ${type} with matching magic bytes`, () => {
    const r = a.validateAttachment({ name: 'f', type, data: `data:${type};base64,${b64(buf)}` });
    assert.equal(r.ext, ext);
    assert.deepEqual(r.buffer, buf);
  });
}

test('accepts raw base64 without data URL prefix', () => {
  const r = a.validateAttachment({ name: 'f', type: 'application/pdf', data: b64(pad('%PDF')) });
  assert.equal(r.ext, '.pdf');
});

test('x-zip-compressed alias requires PK magic', () => {
  assert.throws(
    () => a.validateAttachment({ name: 'x.zip', type: 'application/x-zip-compressed', data: b64(pad('%PDF')) }),
    /does not match/
  );
});

test('no file returns null', () => {
  assert.equal(a.validateAttachment(undefined), null);
  assert.equal(a.validateAttachment(null), null);
});

test('spoofed MIME (html as image/png) is rejected', () => {
  const html = b64('<html><script>alert(1)</script></html>');
  assert.throws(
    () => a.validateAttachment({ name: 'x.png', type: 'image/png', data: html }),
    /File content does not match its type/
  );
});

test('each type rejects another type\'s magic', () => {
  assert.throws(() => a.validateAttachment({ name: 'x', type: 'application/pdf', data: b64(pad([0x89, 0x50, 0x4e, 0x47])) }), /does not match/);
  assert.throws(() => a.validateAttachment({ name: 'x', type: 'application/zip', data: b64(pad('%PDF')) }), /does not match/);
  assert.throws(() => a.validateAttachment({ name: 'x', type: 'image/webp', data: b64(pad('RIFF....WAVE')) }), /does not match/);
});

test('text/plain with NUL byte is rejected', () => {
  assert.throws(
    () => a.validateAttachment({ name: 'x.txt', type: 'text/plain', data: b64(Buffer.from([0x61, 0x00, 0x62])) }),
    /does not match/
  );
});

test('unsupported and non-own-property types are rejected', () => {
  for (const type of ['text/html', 'image/svg+xml', 'application/x-msdownload', 'toString', '__proto__', '']) {
    assert.throws(() => a.validateAttachment({ name: 'x', type, data: b64('abcd') }), ValidationError);
  }
});

test('extension is derived from MIME, not filename', () => {
  const r = a.validateAttachment({ name: 'evil.html', type: 'text/plain', data: b64('hi') });
  assert.equal(r.ext, '.txt');
  assert.equal(a.buildFilename('evil.html', r.ext, 'abcd'), 'abcd-evil.txt');
});

test('oversize is rejected before decoding', (t) => {
  const spy = t.mock.method(Buffer, 'from');
  const big = 'A'.repeat(Math.ceil(((5 * 1024 * 1024 + 10) * 4) / 3 / 4) * 4);
  assert.throws(
    () => a.validateAttachment({ name: 'x', type: 'application/pdf', data: big }),
    /File too large/
  );
  assert.equal(spy.mock.callCount(), 0);
});

test('exactly 5MB is not rejected for size', () => {
  const buf = Buffer.alloc(5 * 1024 * 1024);
  Buffer.from('%PDF').copy(buf);
  const r = a.validateAttachment({ name: 'x', type: 'application/pdf', data: b64(buf) });
  assert.equal(r.buffer.length, buf.length);
});

test('bad base64 is rejected', () => {
  for (const data of ['!!!!', 'abc', 'ab=c', 'a b c d', '', '====', 'data:application/pdf;base64,%%%%']) {
    assert.throws(() => a.validateAttachment({ name: 'x', type: 'application/pdf', data }), ValidationError, data);
  }
  assert.throws(() => a.validateAttachment({ name: 'x', type: 'application/pdf', data: 123 }), ValidationError);
  assert.throws(() => a.validateAttachment('str'), ValidationError);
});

test('sanitizeBase / buildFilename', () => {
  assert.equal(a.sanitizeBase('../../etc/passwd'), 'passwd');
  assert.equal(a.sanitizeBase('my file (1).png'), 'my_file__1_');
  assert.equal(a.sanitizeBase(''), 'file');
  assert.equal(a.sanitizeBase(undefined), 'file');
  assert.ok(a.sanitizeBase('a'.repeat(200)).length <= 40);
  assert.match(a.buildFilename('Report.pdf', '.pdf'), /^[0-9a-f]{16}-Report\.pdf$/);
});
