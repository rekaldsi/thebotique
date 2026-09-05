'use strict';

// Daily snapshot run. This is the clock.
//
// Everything else in the product can be rebuilt later; the history cannot.
// So this deliberately has no dependency on auth, billing, or the web app --
// it is a standalone script that only needs DATABASE_URL, and it should keep
// working untouched even if nothing else is maintained.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const {
  fetchMcpRegistry, fetchClawHub, fetchSmithery, fetchNpm, fetchNpmDeep
} = require('./sources');

// Local convenience only. On Railway the env is injected, and dotenv does
// not override already-set vars, so this is a no-op there.
try { require('dotenv').config(); } catch (_) { /* dotenv is optional */ }

const SCHEMA = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');

function sha256(obj) {
  // Stable stringify: key order must not affect the hash, or every run
  // looks like a change.
  const stable = (v) => {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(stable);
    return Object.keys(v).sort().reduce((o, k) => { o[k] = stable(v[k]); return o; }, {});
  };
  return crypto.createHash('sha256').update(JSON.stringify(stable(obj))).digest('hex');
}

const ALL_SOURCES = ['mcp-registry', 'clawhub', 'smithery', 'npm', 'npm-deep'];

// How many npm packages to enrich with the full package document each run.
// One HTTP request each, so this is the main cost knob.
//
// Raised from 300 after measuring where the signal actually is. Over a
// 24-hour window, 645 artifacts changed across all sources but only 6
// changed in a way that alters what they can do -- because the registry
// search payloads the other sources expose contain no such fields. Scoped
// to the 300 packages where scripts/dependencies/maintainers/integrity ARE
// observable, 3 changed and all 3 were content-integrity changes. Every
// consequential signal we have came from this source, so coverage here is
// the product.
const DEEP_LIMIT = Number(process.env.DEEP_LIMIT || 1500);

// Which packages are worth a deep fetch. Two criteria, in order:
//  1. Already known to run code at install time. A change to a package that
//     executes a postinstall script is the highest-consequence event we can
//     observe, so never let those fall out of coverage.
//  2. Otherwise most-downloaded. Watching a package nobody installs
//     protects nobody.
async function selectDeepTargets(pool, limit) {
  const known = await pool.query(
    `SELECT DISTINCT ON (slug) slug
       FROM artifact_snapshots
      WHERE source = 'npm-deep'
        AND (raw->'scripts' ? 'postinstall' OR raw->'scripts' ? 'preinstall'
             OR raw->'scripts' ? 'install')
      ORDER BY slug, fetched_at DESC`
  );
  const priority = known.rows.map((r) => r.slug);

  const pool2 = await pool.query(
    `SELECT DISTINCT ON (slug) slug, downloads
       FROM artifact_snapshots
      WHERE source = 'npm' AND downloads IS NOT NULL
      ORDER BY slug, fetched_at DESC`
  );
  const byDownloads = pool2.rows
    .sort((a, b) => (b.downloads || 0) - (a.downloads || 0))
    .map((x) => x.slug);

  const seen = new Set();
  const out = [];
  for (const s of [...priority, ...byDownloads]) {
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= limit) break;
  }
  return out;
}

async function run({ maxPages = 20, sources = ALL_SOURCES } = {}) {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSL === 'off' ? false : { rejectUnauthorized: false },
    connectionTimeoutMillis: 15000
  });

  const stats = { fetched: 0, inserted: 0, unchanged: 0, changed: 0, bySource: {} };

  try {
    await pool.query(SCHEMA);

    // Fetched sequentially and each wrapped, so one flaky upstream degrades
    // the run to partial coverage instead of losing the whole day.
    const fetchers = {
      'mcp-registry': () => fetchMcpRegistry({ maxPages }),
      clawhub: () => fetchClawHub({ maxPages }),
      smithery: () => fetchSmithery({ maxPages }),
      npm: () => fetchNpm({ maxPages: Math.min(maxPages, 8) }),
      'npm-deep': async () => fetchNpmDeep(await selectDeepTargets(pool, DEEP_LIMIT))
    };
    const batches = [];
    for (const name of sources) {
      if (!fetchers[name]) continue;
      try {
        batches.push([name, await fetchers[name]()]);
      } catch (e) {
        stats.bySource[name] = { error: e.message, fetched: 0, inserted: 0, unchanged: 0, changed: 0 };
      }
    }

    for (const [name, records] of batches) {
      const s = { fetched: records.length, inserted: 0, unchanged: 0, changed: 0 };

      // One round trip for every prior hash in this source, rather than one
      // per artifact. Over a remote connection the per-record version took
      // minutes; this takes one query.
      const prior = new Map();
      const prevRows = await pool.query(
        `SELECT DISTINCT ON (slug) slug, content_sha
           FROM artifact_snapshots
          WHERE source = $1
          ORDER BY slug, fetched_at DESC`,
        [name]
      );
      for (const row of prevRows.rows) prior.set(row.slug, row.content_sha);

      const pending = [];
      for (const r of records) {
        const contentSha = sha256(r.raw);
        const previousSha = prior.get(r.slug);

        // Unchanged re-fetches are skipped: we store changes, not heartbeats.
        // First sighting always writes (previousSha is undefined).
        if (previousSha === contentSha) { s.unchanged++; continue; }
        if (previousSha) s.changed++;
        pending.push([r.source, r.slug, r.version, r.repoUrl, r.upstreamAt,
                      contentSha, r.installs, r.downloads, r.versions,
                      JSON.stringify(r.raw)]);
      }

      // Multi-row inserts, chunked to stay well under the parameter limit.
      const COLS = 10, CHUNK = 500;
      for (let i = 0; i < pending.length; i += CHUNK) {
        const slice = pending.slice(i, i + CHUNK);
        const values = slice.map((_, n) =>
          `(${Array.from({ length: COLS }, (__, c) => `$${n * COLS + c + 1}`).join(',')})`
        ).join(',');
        await pool.query(
          `INSERT INTO artifact_snapshots
             (source, slug, version, repo_url, upstream_at, content_sha,
              installs, downloads, versions, raw)
           VALUES ${values}`,
          slice.flat()
        );
        s.inserted += slice.length;
      }

      stats.bySource[name] = s;
      stats.fetched += s.fetched; stats.inserted += s.inserted;
      stats.unchanged += s.unchanged; stats.changed += s.changed;
    }
  } finally {
    await pool.end().catch(() => {});
  }
  return stats;
}

if (require.main === module) {
  const pages = Number(process.env.MAX_PAGES || 20);
  run({ maxPages: pages })
    .then((s) => {
      console.log(JSON.stringify({ event: 'collector_run', at: new Date().toISOString(), ...s }));
      process.exit(0);
    })
    .catch((e) => {
      console.error(JSON.stringify({ event: 'collector_error', error: e.message }));
      process.exit(1);
    });
}

module.exports = { run, sha256 };
