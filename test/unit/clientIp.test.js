const test = require('node:test');
const assert = require('node:assert/strict');
const { socketIp } = require('../../src/clientIp');
const { loadConfig } = require('../../src/config');

const sock = (headers, address = '10.0.0.5') => ({ handshake: { headers, address } });

test('without trust proxy the socket address wins, X-Forwarded-For is ignored', () => {
  assert.equal(socketIp(sock({ 'x-forwarded-for': '1.2.3.4' }), false), '10.0.0.5');
});

test('with trust proxy the first X-Forwarded-For entry is used', () => {
  assert.equal(socketIp(sock({ 'x-forwarded-for': '1.2.3.4, 10.0.0.9' }), 1), '1.2.3.4');
  assert.equal(socketIp(sock({ 'x-forwarded-for': ' 2001:db8::1 ,5.6.7.8' }), 1), '2001:db8::1');
});

test('with trust proxy but no or garbage header, falls back to the address', () => {
  assert.equal(socketIp(sock({}), 1), '10.0.0.5');
  assert.equal(socketIp(sock({ 'x-forwarded-for': 'not-an-ip' }), 1), '10.0.0.5');
  assert.equal(socketIp(sock({ 'x-forwarded-for': '' }), 1), '10.0.0.5');
});

test('TRUST_PROXY config parsing', () => {
  assert.equal(loadConfig({ TRUST_PROXY: '1' }).TRUST_PROXY, 1);
  assert.equal(loadConfig({ TRUST_PROXY: 'true' }).TRUST_PROXY, 1);
  assert.equal(loadConfig({ TRUST_PROXY: '0' }).TRUST_PROXY, false);
  assert.equal(loadConfig({}).TRUST_PROXY, false);
});

test('limit config defaults and overrides', () => {
  const c = loadConfig({});
  assert.equal(c.MAX_SOCKETS_PER_IP, 20);
  assert.equal(c.ROOMS_PER_IP, 10);
  assert.equal(c.MAX_UPLOAD_DIR_BYTES, 1024 ** 3);
  assert.equal(loadConfig({ MAX_SOCKETS_PER_IP: '5' }).MAX_SOCKETS_PER_IP, 5);
  assert.equal(loadConfig({ MAX_UPLOAD_DIR_BYTES: 'junk' }).MAX_UPLOAD_DIR_BYTES, 1024 ** 3);
});
