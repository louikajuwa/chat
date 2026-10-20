#!/usr/bin/env node
/**
 * Deletes orphaned upload files: files in UPLOAD_DIR that no message references
 * (matched by basename of messages.attachment_path) and that are older than
 * --min-age-hours (default 24; protects uploads whose message is not inserted yet).
 *
 * Dry run by default. Pass --apply to actually delete.
 *   docker compose exec -T app npm run uploads:prune
 *   docker compose exec -T app npm run uploads:prune -- --apply --min-age-hours 72
 *
 * Note: the running server keeps its own upload-size counter from startup; restart
 * it after pruning to reclaim the quota.
 */
const path = require('path');
const fs = require('fs/promises');
const { loadConfig } = require('../src/config');
const { createPool } = require('../src/db');

const DEFAULT_MIN_AGE_HOURS = 24;

// Pure: decides what to delete.
// files: [{ name, size, mtimeMs }]; referenced: Set of basenames.
function planPrune({ files, referenced, minAgeMs, now = Date.now() }) {
  const toDelete = files.filter(
    (f) => !referenced.has(f.name) && now - f.mtimeMs >= minAgeMs
  );
  return { toDelete, totalBytes: toDelete.reduce((sum, f) => sum + f.size, 0) };
}

async function listFiles(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const files = [];
  for (const e of entries) {
    if (!e.isFile() || e.name.startsWith('.')) continue; // non-recursive, skip dotfiles
    const st = await fs.stat(path.join(dir, e.name));
    files.push({ name: e.name, size: st.size, mtimeMs: st.mtimeMs });
  }
  return files;
}

async function referencedBasenames(pool) {
  const [rows] = await pool.query('SELECT attachment_path FROM messages WHERE attachment_path IS NOT NULL');
  return new Set(rows.map((r) => path.posix.basename(r.attachment_path)));
}

// Returns { toDelete, totalBytes, deleted } (deleted is [] on a dry run).
async function prune({ dir, pool, minAgeHours = DEFAULT_MIN_AGE_HOURS, apply = false, now = Date.now() }) {
  const files = await listFiles(dir);
  const referenced = await referencedBasenames(pool);
  const plan = planPrune({ files, referenced, minAgeMs: minAgeHours * 3600 * 1000, now });
  const deleted = [];
  if (apply) {
    for (const f of plan.toDelete) {
      await fs.rm(path.join(dir, f.name), { force: true });
      deleted.push(f.name);
    }
  }
  return { ...plan, deleted };
}

function parseArgs(argv) {
  const opts = { apply: false, minAgeHours: DEFAULT_MIN_AGE_HOURS };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') opts.apply = true;
    else if (a === '--min-age-hours' || a.startsWith('--min-age-hours=')) {
      const raw = a.includes('=') ? a.split('=')[1] : argv[++i];
      const n = Number(raw);
      if (raw === undefined || raw === '' || !Number.isFinite(n) || n < 0) {
        throw new Error('--min-age-hours needs a number >= 0');
      }
      opts.minAgeHours = n;
    } else throw new Error(`Unknown argument: ${a}`);
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const pool = createPool(config);
  try {
    const res = await prune({ dir: config.UPLOAD_DIR, pool, ...opts });
    const verb = opts.apply ? 'Deleted' : 'Would delete';
    for (const f of res.toDelete) console.log(`${opts.apply ? 'deleted' : 'would delete'} ${f.name} (${f.size} bytes)`);
    console.log(`${verb} ${res.toDelete.length} file(s), ${res.totalBytes} bytes (older than ${opts.minAgeHours}h, unreferenced) in ${config.UPLOAD_DIR}`);
    if (!opts.apply) console.log('Dry run. Re-run with --apply to delete.');
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('prune-uploads failed:', err.message);
    process.exit(1);
  });
}

module.exports = { planPrune, listFiles, prune, parseArgs, DEFAULT_MIN_AGE_HOURS };
