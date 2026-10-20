// Fixed-window counter keyed by string. No deps, in-memory.
function createLimiter({ limit, windowMs }) {
  const hits = new Map(); // key -> { count, resetAt }

  function prune(now = Date.now()) {
    for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
  }

  // Returns true if the hit is allowed.
  function hit(key = '', now = Date.now()) {
    if (hits.size > 1000) prune(now);
    let e = hits.get(key);
    if (!e || e.resetAt <= now) {
      e = { count: 0, resetAt: now + windowMs };
      hits.set(key, e);
    }
    e.count += 1;
    return e.count <= limit;
  }

  return { hit, prune, size: () => hits.size };
}

module.exports = { createLimiter };
