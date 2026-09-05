'use strict';

// Change digests.
//
// Runs after the daily crawl. For each watch, compares the hash the
// subscriber was last told about against the newest observation. That
// comparison is deliberately against notified_sha rather than against
// "did anything change yesterday": if a run is missed, or a send fails,
// the change is still pending and goes out next time. A monitoring product
// that can silently skip an alert is worse than no monitoring product.

const mail = require('./mail');
const { SITE } = require('./render');

// Fields whose change alters what an extension can do. Ordered first in
// the digest so the consequential line is the one people read.
const CONSEQUENTIAL = [
  'scripts', 'dependencies', 'maintainers', 'integrity', 'repository',
  'license', 'deprecated', 'remotes', 'packages', 'owner'
];

function diffFields(a, b) {
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  const out = [];
  for (const k of keys) {
    if (JSON.stringify(a && a[k]) !== JSON.stringify(b && b[k])) out.push(k);
  }
  return out.sort((x, y) => {
    const cx = CONSEQUENTIAL.indexOf(x), cy = CONSEQUENTIAL.indexOf(y);
    if (cx === -1 && cy === -1) return x.localeCompare(y);
    if (cx === -1) return 1;
    if (cy === -1) return -1;
    return cx - cy;
  });
}

// Pending changes, grouped by account.
async function pending(db) {
  const rows = (await db.query(
    `SELECT w.id, w.account_id, w.source, w.slug, w.notified_sha,
            a.email, a.plan,
            s.content_sha AS latest_sha, s.raw AS latest_raw, s.version, s.fetched_at
       FROM drift_watches w
       JOIN drift_accounts a ON a.id = w.account_id
       JOIN LATERAL (
            SELECT content_sha, raw, version, fetched_at
              FROM artifact_snapshots
             WHERE source = w.source AND slug = w.slug
             ORDER BY fetched_at DESC LIMIT 1
       ) s ON true
      WHERE w.notified_sha IS DISTINCT FROM s.content_sha`
  )).rows;

  const byAccount = new Map();
  for (const r of rows) {
    // The observation the subscriber last saw, so the diff is against what
    // they were actually told, not merely against the previous row.
    const prev = (await db.query(
      `SELECT raw, version FROM artifact_snapshots
        WHERE source = $1 AND slug = $2 AND content_sha = $3
        ORDER BY fetched_at DESC LIMIT 1`,
      [r.source, r.slug, r.notified_sha]
    )).rows[0];

    const fields = prev ? diffFields(prev.raw, r.latest_raw) : [];
    const consequential = fields.filter((f) => CONSEQUENTIAL.includes(f));
    if (!byAccount.has(r.account_id)) {
      byAccount.set(r.account_id, { email: r.email, plan: r.plan, items: [] });
    }
    byAccount.get(r.account_id).items.push({
      watchId: r.id,
      source: r.source,
      slug: r.slug,
      latestSha: r.latest_sha,
      from: prev ? prev.version : null,
      to: r.version,
      fields,
      consequential,
      // First observation after a watch was added, or a hash we no longer
      // hold the predecessor for.
      firstSighting: !prev
    });
  }
  return byAccount;
}

function compose(items) {
  const conseq = items.filter((i) => i.consequential.length);
  const rest = items.filter((i) => !i.consequential.length);
  const line = (i) => {
    const url = `${SITE}/drift/x/${i.source}/${encodeURIComponent(i.slug)}`;
    const ver = i.from && i.to && i.from !== i.to ? ` ${i.from} -> ${i.to}` : (i.to ? ` (${i.to})` : '');
    const what = i.firstSighting
      ? 'first observation recorded since you added it'
      : (i.fields.length ? `changed: ${i.fields.slice(0, 6).join(', ')}` : 'record changed');
    return `- ${i.slug} [${i.source}]${ver}\n  ${what}\n  ${url}`;
  };

  const parts = [];
  if (conseq.length) {
    parts.push(
      `${conseq.length} of the extensions you watch changed something that affects what they can do:\n\n` +
      conseq.map(line).join('\n\n')
    );
  }
  if (rest.length) {
    parts.push(
      `${rest.length} changed in description or version only:\n\n` + rest.map(line).join('\n\n')
    );
  }
  parts.push(
    'These are observations of published records, not assessments of safety. ' +
    'A change is usually an ordinary release.\n\n' +
    `Manage what you watch: ${SITE}/drift/watch`
  );
  return parts.join('\n\n---\n\n');
}

async function run(db, { logger = console } = {}) {
  const stats = { accounts: 0, items: 0, sent: 0, failed: 0, skipped: 0 };
  if (!mail.configured() && process.env.NODE_ENV === 'production') {
    stats.skipped = 1;
    return stats;
  }

  const byAccount = await pending(db);
  for (const [, acct] of byAccount) {
    stats.accounts++;
    stats.items += acct.items.length;
    const conseq = acct.items.filter((i) => i.consequential.length).length;
    const subject = conseq
      ? `${conseq} watched extension${conseq > 1 ? 's' : ''} changed what ${conseq > 1 ? 'they' : 'it'} can do`
      : `${acct.items.length} watched extension${acct.items.length > 1 ? 's' : ''} changed`;

    const res = await mail.send({ to: acct.email, subject, text: compose(acct.items) });

    if (res.ok) {
      // Mark notified ONLY after a successful send. A failed send leaves
      // the change pending so it goes out on the next run rather than
      // vanishing.
      for (const i of acct.items) {
        await db.query('UPDATE drift_watches SET notified_sha = $1 WHERE id = $2',
          [i.latestSha, i.watchId]);
      }
      stats.sent++;
    } else {
      stats.failed++;
      (logger.warn || console.warn)('digest send failed', { error: res.error });
    }
  }
  return stats;
}

module.exports = { run, pending, compose, diffFields, CONSEQUENTIAL };
