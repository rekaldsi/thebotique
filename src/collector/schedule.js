'use strict';

// Daily scheduler, run in-process by the web service.
//
// Deliberately not a separate Railway service or an external cron: fewer
// moving parts means fewer things to notice have broken. The web service is
// already deployed and already stays up, so piggybacking on it is the most
// abandonment-resistant option available.
//
// Guarded by a DB timestamp rather than an in-memory flag, so a redeploy or
// crash-restart cannot cause a second run on the same day.

const { run } = require('./run');

const DAY_MS = 24 * 60 * 60 * 1000;
const CHECK_MS = 60 * 60 * 1000; // hourly wakeup, daily work

async function lastRunAt(db) {
  try {
    const r = await db.query(
      `SELECT max(fetched_at) AS at FROM artifact_snapshots`
    );
    return r.rows[0] && r.rows[0].at ? new Date(r.rows[0].at) : null;
  } catch (_) {
    return null; // table not created yet; the first run will create it
  }
}

function start({ db, logger = console } = {}) {
  if (process.env.COLLECTOR_ENABLED === 'false') {
    logger.info && logger.info('collector disabled via COLLECTOR_ENABLED=false');
    return null;
  }

  let running = false;

  const tick = async () => {
    if (running) return;
    const last = await lastRunAt(db);
    if (last && Date.now() - last.getTime() < DAY_MS) return;

    running = true;
    const started = Date.now();
    try {
      const stats = await run({ maxPages: Number(process.env.MAX_PAGES || 45) });

      // Repository liveness, bounded by whether we have a token. Without
      // one GitHub allows 60 requests/hour, so we take a small bite rather
      // than burn the budget and get rate-limited mid-run.
      try {
        const repocheck = require('./repocheck');
        const budget = process.env.GITHUB_TOKEN ? 1500 : 40;
        const rs = await repocheck.run(db, { limit: budget });
        (logger.info || console.log)('repo liveness checked', { event: 'repocheck', ...rs });
      } catch (e) {
        (logger.warn || console.warn)('repo check failed', { error: e.message });
      }

      // Digests last: they compare against what each subscriber was already
      // told, so they must run after both the crawl and the repo check.
      try {
        const alerts = require('../drift/alerts');
        const as = await alerts.run(db, { logger });
        (logger.info || console.log)('digests processed', { event: 'digests', ...as });
      } catch (e) {
        (logger.warn || console.warn)('digest run failed', { error: e.message });
      }
      const line = {
        event: 'collector_run',
        ms: Date.now() - started,
        fetched: stats.fetched,
        inserted: stats.inserted,
        changed: stats.changed,
        unchanged: stats.unchanged
      };
      logger.info ? logger.info('collector run complete', line) : console.log(JSON.stringify(line));
    } catch (e) {
      // Never throw out of the scheduler: a failed crawl must not take the
      // web service down with it.
      const line = { event: 'collector_error', error: e.message };
      logger.error ? logger.error('collector run failed', line) : console.error(JSON.stringify(line));
    } finally {
      running = false;
    }
  };

  // Delay the first check so it never competes with boot/healthcheck.
  const first = setTimeout(tick, 2 * 60 * 1000);
  const timer = setInterval(tick, CHECK_MS);
  if (first.unref) first.unref();
  if (timer.unref) timer.unref();
  return { tick, stop: () => { clearTimeout(first); clearInterval(timer); } };
}

module.exports = { start };
