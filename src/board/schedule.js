'use strict';

// Checkpointing on a cadence.
//
// A log that only checkpoints when someone asks is not a log -- the whole
// value is that a checkpoint existed at a time, before anyone knew what would
// later need proving. So this runs unattended.
//
// It runs in-process rather than as a separate service, matching how the
// collector already works here: fewer moving parts, and nothing to forget to
// restart. The guard against a redeploy or a second replica double-writing is
// the same one the collector uses -- ask the database what it already has
// rather than keeping state in memory.

const S = require('./store');

const EVERY_MS = Number(process.env.SIGIL_CHECKPOINT_MS || 5 * 60 * 1000);

async function tickOnce(db, log) {
  try {
    const r = (await db.query(`
      SELECT
        (SELECT max(id) FROM board_posts)                       AS newest_post,
        (SELECT max(tree_size) FROM board_checkpoints)          AS last_size,
        (SELECT count(*)::int FROM board_posts)                 AS posts,
        (SELECT count(*)::int FROM board_checkpoints)           AS checkpoints
    `)).rows[0];

    // The empty log still deserves a first checkpoint: the root of nothing is
    // a real root and it verifies, which is exactly what a reader should be
    // able to confirm on day one.
    const need = r.checkpoints === 0 || Number(r.posts) !== Number(r.last_size);
    if (!need) return null;

    const cp = await S.buildCheckpoint(db);
    log.info('board checkpoint', {
      id: cp.id, tree_size: cp.tree_size, signed: cp.signed,
      root: cp.root.slice(0, 16)
    });
    if (!cp.signed) {
      log.warn('checkpoint stored UNSIGNED — SIGIL_LOG_KEY is not set or unusable. ' +
               'An unsigned checkpoint cannot be attributed by anyone outside.');
    }
    return cp;
  } catch (e) {
    log.warn('board checkpoint failed', { error: e.message });
    return null;
  }
}

function start(db, log) {
  // Stated once, on every boot, regardless of whether checkpointing itself is
  // enabled below: two instances (production, and anything pointed at a
  // different database) sign checkpoints under the same ORIGIN unless
  // SIGIL_ORIGIN is set per-instance, and that has been hard to tell from the
  // logs alone. This does not change the default or prod's signed lineage --
  // it just says out loud what this running process is using.
  log.info('board checkpoint origin: ' + S.ORIGIN);
  if (process.env.SIGIL_CHECKPOINTS === 'false') {
    log.info('board checkpointing disabled by SIGIL_CHECKPOINTS=false');
    return;
  }
  // A short delay so boot is not competing with schema init.
  setTimeout(() => tickOnce(db, log), 20 * 1000);
  setInterval(() => tickOnce(db, log), EVERY_MS);
  log.info('board checkpointing every ' + Math.round(EVERY_MS / 1000) + 's');
}

module.exports = { start, tickOnce, EVERY_MS };
