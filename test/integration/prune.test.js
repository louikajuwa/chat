const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startServer, newRoom } = require('../helpers');
const { planPrune, prune, parseArgs } = require('../../scripts/prune-uploads');

const H = 3600 * 1000;

test('planPrune (pure): only unreferenced files at least min-age old', () => {
  const now = 1_000_000_000;
  const files = [
    { name: 'old-orphan', size: 10, mtimeMs: now - 48 * H },
    { name: 'old-used', size: 20, mtimeMs: now - 48 * H },
    { name: 'young-orphan', size: 40, mtimeMs: now - 1 * H },
  ];
  const plan = planPrune({ files, referenced: new Set(['old-used']), minAgeMs: 24 * H, now });
  assert.deepEqual(plan.toDelete.map((f) => f.name), ['old-orphan']);
  assert.equal(plan.totalBytes, 10);
});

test('parseArgs', () => {
  assert.deepEqual(parseArgs([]), { apply: false, minAgeHours: 24 });
  assert.deepEqual(parseArgs(['--apply', '--min-age-hours', '2']), { apply: true, minAgeHours: 2 });
  assert.deepEqual(parseArgs(['--min-age-hours=0.5']), { apply: false, minAgeHours: 0.5 });
  assert.throws(() => parseArgs(['--min-age-hours', 'x']));
  assert.throws(() => parseArgs(['--nope']));
});

test('prune: dry run reports, --apply deletes only old unreferenced files', async () => {
  const ctx = await startServer();
  try {
    const dir = ctx.uploadDir;
    const room = newRoom();
    await ctx.pool.query('INSERT INTO chat_room (room, sender_name) VALUES (?, ?)', [room, 'P']);
    await ctx.pool.query(
      "INSERT INTO messages (sender_name, message, room, readMessage, attachment_path) VALUES ('P', '', ?, 'no', ?)",
      [room, '/attachement/used-old.png']
    );
    const old = new Date(Date.now() - 48 * H);
    const put = (name, bytes, mtime) => {
      fs.writeFileSync(path.join(dir, name), Buffer.alloc(bytes));
      fs.utimesSync(path.join(dir, name), mtime, mtime);
    };
    put('used-old.png', 5, old);
    put('orphan-old-1.png', 7, old);
    put('orphan-old-2.pdf', 11, old);
    put('orphan-young.png', 13, new Date());
    fs.mkdirSync(path.join(dir, 'subdir'));

    const dry = await prune({ dir, pool: ctx.pool, apply: false });
    assert.deepEqual(dry.toDelete.map((f) => f.name).sort(), ['orphan-old-1.png', 'orphan-old-2.pdf']);
    assert.equal(dry.totalBytes, 18);
    assert.deepEqual(dry.deleted, []);
    assert.equal(fs.readdirSync(dir).length, 5, 'dry run must not delete');

    const real = await prune({ dir, pool: ctx.pool, apply: true });
    assert.deepEqual(real.deleted.sort(), ['orphan-old-1.png', 'orphan-old-2.pdf']);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['orphan-young.png', 'subdir', 'used-old.png']);

    const custom = await prune({ dir, pool: ctx.pool, apply: true, minAgeHours: 0 });
    assert.deepEqual(custom.deleted, ['orphan-young.png']);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['subdir', 'used-old.png']);
  } finally {
    await ctx.close();
  }
});
