const net = require('net');

// Client IP of a Socket.IO socket. Behind a trusted reverse proxy (TRUST_PROXY)
// the first X-Forwarded-For entry is used; otherwise the TCP peer address, since
// the header is client-controlled and would let anyone dodge per-IP limits.
function socketIp(socket, trustProxy) {
  const { headers = {}, address } = socket.handshake;
  if (trustProxy) {
    const xff = headers['x-forwarded-for'];
    const first = String(Array.isArray(xff) ? xff[0] : xff || '').split(',')[0].trim();
    if (net.isIP(first)) return first;
  }
  return address || 'unknown';
}

module.exports = { socketIp };
