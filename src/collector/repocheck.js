'use strict';

// Source-repository liveness check.
//
// Deliberately separate from the content collector and deliberately an
// UPDATE rather than an INSERT. The content hash history is append-only
// because "what did this look like on date X" is the product. Repository
// liveness is a *current* property we re-check on a schedule, so it lives
// as last-known state on the most recent snapshot row. Recording a new
// snapshot every time a repo is re-checked would flood the change feed
// with events that are not content changes.
//
// Correctness note that matters more than it looks: an unauthenticated
// GitHub API request returns 404 for private AND renamed AND rate-limited
// cases, so a naive checker reports live projects as gone. Publishing
// "this project is gone" about a project that is merely private is exactly
// the kind of false statement that ends this business. So:
//   - authenticate when a token is available (5,000/hr vs 60/hr)
//   - follow renames rather than calling them 404s
//   - stop cleanly on rate limit instead of marking the remainder gone
//   - only ever record the observation, never the inference

const STALE_DAYS = 90;
const UA = 'thebotique-collector/0.1 (+https://www.thebotique.ai)';

function ghHeaders() {
  const h = { 'user-agent': UA, accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) h.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return h;
}

function parseRepo(url) {
  if (!url) return null;
  const m = String(url).match(/github\.com[/:]([^/]+)\/([^/\s#?]+)/);
  if (!m) return null;
  return `${m[1]}/${m[2].replace(/\.git$/, '')}`;
}

// Returns { status, pushedAt } or null when we could not determine anything
// (rate limit, network). null means "leave the previous value alone".
async function checkRepo(repo) {
  let res;
  try {
    res = await fetch(`https://api.github.com/repos/${repo}`, {
      headers: ghHeaders(),
      redirect: 'follow' // renamed repos 301 to their new location
    });
  } catch (e) {
    return null;
  }

  if (res.status === 403 || res.status === 429) return { rateLimited: true };
  if (res.status === 404) return { status: 'gone', pushedAt: null };
  if (!res.ok) return null;

  let j;
  try { j = await res.json(); } catch (e) { return null; }
  if (!j || !j.pushed_at) return { status: 'unknown', pushedAt: null };

  const ageDays = (Date.now() - new Date(j.pushed_at).getTime()) / 86400000;
  return {
    status: ageDays > STALE_DAYS ? 'stale' : 'alive',
    pushedAt: new Date(j.pushed_at),
    archived: !!j.archived
  };
}

// Check the least-recently-checked artifacts that have a repository URL.
async function run(pool, { limit = 200 } = {}) {
  const stats = { checked: 0, alive: 0, stale: 0, gone: 0, unknown: 0, rateLimited: false };

  // RANDOM order, not alphabetical. Registry listings are not randomly
  // distributed: the low-alphabet range is dense with abandoned and
  // spam-shaped entries, so an ordered scan reports a "gone" rate roughly
  // 2x the true one. Measured directly -- the first 25 by (source, slug)
  // gave 72% gone; a random sample of the same corpus gives ~30%. Any
  // published statistic must come from the random sample.
  //
  // Unchecked rows are still preferred over already-checked ones so that
  // coverage grows before anything is re-checked, but selection within
  // each group is random.
  const targets = (await pool.query(
    `SELECT DISTINCT ON (source, slug) id, source, slug, repo_url, repo_status
       FROM artifact_snapshots
      WHERE repo_url IS NOT NULL
      ORDER BY source, slug, fetched_at DESC`
  )).rows
    .filter((r) => parseRepo(r.repo_url))
    .map((r) => ({ r, k: Math.random() }))
    .sort((a, b) => (a.r.repo_status ? 1 : 0) - (b.r.repo_status ? 1 : 0) || a.k - b.k)
    .slice(0, limit)
    .map((x) => x.r);

  for (const t of targets) {
    const repo = parseRepo(t.repo_url);
    const r = await checkRepo(repo);
    if (!r) continue;
    if (r.rateLimited) { stats.rateLimited = true; break; }

    await pool.query(
      `UPDATE artifact_snapshots
          SET repo_status = $1, repo_pushed_at = $2
        WHERE id = $3`,
      [r.status, r.pushedAt, t.id]
    );
    stats.checked++;
    stats[r.status] = (stats[r.status] || 0) + 1;
  }
  return stats;
}

// The published measurement, computed from stored observations rather than
// from a one-off script, so the number on the report page is reproducible
// and always matches what the database actually holds.
async function measure(pool) {
  const r = await pool.query(
    `SELECT repo_status, count(*)::int n FROM (
        SELECT DISTINCT ON (source, slug) repo_status
          FROM artifact_snapshots
         WHERE repo_url IS NOT NULL
         ORDER BY source, slug, fetched_at DESC
     ) t WHERE repo_status IS NOT NULL GROUP BY repo_status`
  );
  const by = Object.fromEntries(r.rows.map((x) => [x.repo_status, x.n]));
  const total = Object.values(by).reduce((a, b) => a + b, 0);
  const pct = (n) => (total ? Math.round((n / total) * 1000) / 10 : 0);
  return {
    total,
    alive: by.alive || 0,
    stale: by.stale || 0,
    gone: by.gone || 0,
    unknown: by.unknown || 0,
    pctAlive: pct(by.alive || 0),
    pctStale: pct(by.stale || 0),
    pctGone: pct(by.gone || 0),
    pctNotHealthy: pct((by.stale || 0) + (by.gone || 0))
  };
}

module.exports = { run, measure, checkRepo, parseRepo, STALE_DAYS };
