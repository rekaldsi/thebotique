'use strict';

// Public read surface. Seven routes, all GET, no auth, no writes.
//
// Everything here is free and crawlable on purpose, for two reasons:
// AI crawlers do not execute JS and do not log in, so a gated corpus is
// invisible to them; and adverse observations published broadly are far
// better protected than the same observations sent privately to paying
// subscribers. The paid tier will sell timeliness, history depth and API
// access -- never exclusive access to an adverse finding.

const express = require('express');
// Layout and escaping come from the one design system. The archive-specific
// helpers stay where they are -- render.js is now a utility module, not a
// second stylesheet. Destructuring a missing export yields undefined rather
// than throwing, so a wrong import here would have passed every syntax check
// and died on the first request.
const { esc, layout, SITE } = require('../sigil/wire');
const { repoObservation, changedFields, CONSEQUENTIAL, iso, day } = require('./render');
const { REPORTS, INDEX, jsonldFor } = require('./reports');
const auth = require('./auth');

const router = express.Router();
const SOURCES = ['mcp-registry', 'clawhub', 'smithery', 'npm', 'npm-deep'];
const LABEL = {
  'mcp-registry': 'Official MCP Registry', clawhub: 'ClawHub',
  smithery: 'Smithery', npm: 'npm', 'npm-deep': 'npm (package document)'
};

function mount(db) {
  const q = (sql, params) => db.query(sql, params);

  // --- overview -------------------------------------------------------------
  // Serves BOTH the site root and /drift. The root is the point: the
  // marketplace this site used to be never completed a transaction, and
  // leaving it as the front door meant the actual product was invisible to
  // anyone who typed the domain. This router mounts before hubRouter, so
  // this handler wins over the old marketplace homepage.
  router.get(['/extensions', '/drift'], async (req, res, next) => {
    try {
      const [tot, bySrc, recent] = await Promise.all([
        q(`SELECT count(DISTINCT slug)::int a, count(*)::int r, min(fetched_at) started
             FROM artifact_snapshots`),
        q(`SELECT source, count(DISTINCT slug)::int n FROM artifact_snapshots
            GROUP BY source ORDER BY 2 DESC`),
        q(`SELECT source, slug, count(*)::int obs, max(fetched_at) last
             FROM artifact_snapshots GROUP BY source, slug HAVING count(*) > 1
            ORDER BY max(fetched_at) DESC LIMIT 15`)
      ]);
      const t = tot.rows[0];
      const body = `
<h1>What changed in the agent extensions you installed</h1>
<p class="lede">TheBotique takes a daily fingerprint of publicly listed AI agent extensions
&mdash; MCP servers, agent skills and npm packages &mdash; and keeps every version it has seen.
Extensions update themselves after you approve them. This is the record of when they did.</p>
<div class="card"><dl class="kv">
<dt>Extensions tracked</dt><dd><strong>${t.a.toLocaleString()}</strong></dd>
<dt>Observations recorded</dt><dd>${t.r.toLocaleString()}</dd>
<dt>Archive begins</dt><dd>${esc(iso(t.started))}</dd>
<dt>Sources</dt><dd>${bySrc.rows.map((s) => `${esc(LABEL[s.source] || s.source)} (${s.n.toLocaleString()})`).join(' &middot; ')}</dd>
</dl></div>
<p class="muted">Vendor-neutral by construction: five independent registries, none dominant.
TheBotique is not affiliated with or endorsed by any of them.</p>
<h2>Most recently changed</h2>
${recent.rows.length ? `<div class="scroll"><table><tr><th>Extension</th><th>Source</th><th>Observations</th><th>Last change</th></tr>
${recent.rows.map((r) => `<tr><td><a href="/drift/x/${esc(r.source)}/${encodeURIComponent(r.slug)}">${esc(r.slug)}</a></td>
<td>${esc(LABEL[r.source] || r.source)}</td><td>${r.obs}</td><td>${esc(day(r.last))}</td></tr>`).join('')}
</table></div>` : '<p class="muted">No changes recorded yet. The archive begins today.</p>'}
<p style="margin-top:18px"><a href="/drift/changes">All recorded changes &rarr;</a></p>
<div class="card"><p style="margin:0"><strong>Watch the ones you actually installed.</strong> Free, no card, up to five &mdash; <a href="/drift/login">sign in with an email address</a> and we will email you when one of them changes.</p></div>
<div class="card" style="border-color:var(--rule-mark)"><p style="margin:0 0 6px"><strong>Why this archive sits next to a signed board.</strong></p><p style="margin:0">An extension can change under you between the version you read and the version that runs. That is the same problem the board solves for posts, applied to code: a record is only worth what it costs to alter without anyone noticing. <a href="/">See how the board handles it</a>.</p></div>
<h2>Measured reports</h2>
<ul class="plain">${INDEX.map((i) => `<li><a href="/drift/reports/${i[0]}">${esc(i[1])}</a></li>`).join('')}</ul>`;
      // One canonical URL for one page, whichever path was requested.
      res.send(layout({
        title: 'TheBotique — know when your AI agent tools change',
        description: `Daily change records for ${t.a.toLocaleString()} AI agent extensions across five registries. Vendor-neutral.`,
        canonical: `${SITE}/drift`,
        jsonld: {
          '@context': 'https://schema.org', '@type': 'Dataset',
          name: 'TheBotique agent extension observation archive',
          description: 'Daily observations of publicly listed AI agent extensions, including version, source repository status and, for npm packages, install scripts, dependencies, maintainers and content integrity hashes.',
          url: `${SITE}/drift`, isAccessibleForFree: true,
          temporalCoverage: `${iso(t.started)}/..`,
          creator: { '@type': 'Organization', name: 'TheBotique', url: SITE }
        },
        body
      }));
    } catch (e) { next(e); }
  });

  // --- change feed ----------------------------------------------------------
  router.get('/drift/changes', async (req, res, next) => {
    try {
      const rows = (await q(
        `SELECT source, slug, count(*)::int obs, max(fetched_at) last, min(fetched_at) first
           FROM artifact_snapshots GROUP BY source, slug HAVING count(*) > 1
          ORDER BY max(fetched_at) DESC LIMIT 200`
      )).rows;
      const body = `
<h1>Recorded changes</h1>
<p class="lede">Extensions whose published record differed between two observations.
A change is not by itself a problem &mdash; most are ordinary releases. It is a prompt to look.</p>
${rows.length ? `<div class="scroll"><table><tr><th>Extension</th><th>Source</th><th>Observations</th><th>First seen</th><th>Last change</th></tr>
${rows.map((r) => `<tr><td><a href="/drift/x/${esc(r.source)}/${encodeURIComponent(r.slug)}">${esc(r.slug)}</a></td>
<td>${esc(LABEL[r.source] || r.source)}</td><td>${r.obs}</td><td>${esc(day(r.first))}</td><td>${esc(day(r.last))}</td></tr>`).join('')}
</table></div>` : '<p class="muted">Nothing recorded yet.</p>'}`;
      res.send(layout({
        title: 'Recorded changes — TheBotique',
        description: 'AI agent extensions whose published record changed between daily observations.',
        canonical: `${SITE}/drift/changes`, body
      }));
    } catch (e) { next(e); }
  });

  // --- dossier --------------------------------------------------------------
  router.get('/drift/x/:source/:slug', async (req, res, next) => {
    try {
      const { source } = req.params;
      const slug = decodeURIComponent(req.params.slug);
      if (!SOURCES.includes(source)) return next();
      const rows = (await q(
        `SELECT * FROM artifact_snapshots WHERE source = $1 AND slug = $2
          ORDER BY fetched_at ASC`, [source, slug]
      )).rows;
      if (!rows.length) return next();

      const latest = rows[rows.length - 1];
      const r = latest.raw || {};
      // Thin-content rule: a single observation with no repository is not
      // worth indexing yet. Publishing thousands of those is how a corpus
      // gets classified as scaled content abuse.
      const thin = rows.length < 2 && !latest.repo_url;

      const diffs = [];
      for (let i = 1; i < rows.length; i++) {
        const f = changedFields(rows[i - 1].raw, rows[i].raw);
        if (f.length) diffs.push({ at: rows[i].fetched_at, fields: f, prev: rows[i - 1], cur: rows[i] });
      }
      diffs.reverse();

      // Whether the person reading this page is signed in, and whether they
      // already watch this artifact. Failure here must never break a public
      // page, so it degrades to "signed out".
      const viewer = await auth.currentAccount(db, req).catch(() => null);
      const watching = viewer
        ? (await q(
            'SELECT 1 FROM drift_watches WHERE account_id = $1 AND source = $2 AND slug = $3',
            [viewer.id, source, slug]
          )).rows.length > 0
        : false;

      const scripts = r.scripts && Object.keys(r.scripts).length ? r.scripts : null;
      const installHooks = scripts
        ? Object.keys(scripts).filter((k) => ['preinstall', 'install', 'postinstall', 'prepare'].includes(k))
        : [];

      const body = `
<h1>${esc(r.displayName || r.name || r.title || slug)}</h1>
<p class="lede">${esc(r.summary || r.description || 'No description published.').slice(0, 300)}</p>
<span class="obs">as observed ${esc(iso(latest.fetched_at))}</span>

${watching ? `<div class="card" style="border-color:var(--accent)">
<p style="margin:0 0 8px"><strong>You are watching this.</strong> We will email you when its record changes.</p>
<form method="post" action="/drift/watch" style="margin:0">
<input type="hidden" name="source" value="${esc(source)}">
<input type="hidden" name="slug" value="${esc(slug)}">
<input type="hidden" name="remove" value="1">
<button type="submit" style="background:none;border:1px solid var(--rule);color:var(--ink-2);padding:5px 12px;cursor:pointer;font-family:var(--mono);font-size:12px;letter-spacing:.06em">Stop watching</button>
</form></div>`
: viewer ? `<form method="post" action="/drift/watch" class="card" style="margin-bottom:14px">
<input type="hidden" name="source" value="${esc(source)}">
<input type="hidden" name="slug" value="${esc(slug)}">
<p style="margin:0 0 10px">Get an email when this changes.</p>
<button type="submit" class="cta">Watch this</button>
</form>`
: `<div class="card"><p style="margin:0">Want to know when this changes?
<a href="/drift/login">Sign in with an email address</a> and we will tell you. Free, no card,
watch up to 5.</p></div>`}

<div class="card"><dl class="kv">
<dt>Identifier</dt><dd><code>${esc(slug)}</code></dd>
<dt>Source</dt><dd>${esc(LABEL[source] || source)}</dd>
<dt>Version observed</dt><dd>${esc(latest.version || 'not published')}</dd>
<dt>Source repository</dt><dd>${latest.repo_url ? `<a href="${esc(latest.repo_url)}" rel="nofollow noopener">${esc(latest.repo_url)}</a>` : 'not published'}</dd>
<dt>Repository observation</dt><dd>${esc(repoObservation(latest))}</dd>
<dt>First observed here</dt><dd>${esc(iso(rows[0].fetched_at))}</dd>
<dt>Observations recorded</dt><dd>${rows.length}</dd>
${latest.installs != null ? `<dt>Installs (reported upstream)</dt><dd>${Number(latest.installs).toLocaleString()}</dd>` : ''}
${latest.downloads != null ? `<dt>Weekly downloads (upstream)</dt><dd>${Number(latest.downloads).toLocaleString()}</dd>` : ''}
${r.maintainers && r.maintainers.length ? `<dt>Publish rights held by</dt><dd>${r.maintainers.map(esc).join(', ')}</dd>` : ''}
${r.integrity ? `<dt>Content hash (upstream)</dt><dd><code>${esc(String(r.integrity).slice(0, 44))}…</code></dd>` : ''}
${r.license ? `<dt>Declared license</dt><dd>${esc(r.license)}</dd>` : ''}
</dl></div>

${installHooks.length ? `<h2>Runs code at install time</h2>
<p class="muted">These lifecycle scripts execute on the installing machine. This is a factual
property of the published package, common and often benign &mdash; it is listed because a change
to it changes what installing this does.</p>
<div class="card"><dl class="kv">
${installHooks.map((k) => `<dt><code>${esc(k)}</code></dt><dd><code>${esc(String(scripts[k]).slice(0, 220))}</code></dd>`).join('')}
</dl></div>` : ''}

<h2>Observation history</h2>
${diffs.length ? diffs.map((d) => {
  const ordered = d.fields.slice().sort((a, b) => (CONSEQUENTIAL.has(b) ? 1 : 0) - (CONSEQUENTIAL.has(a) ? 1 : 0));
  return `<div class="card"><span class="obs">${esc(iso(d.at))}</span>
<p style="margin:10px 0 6px">Fields that differed: ${ordered.map((f) => `<code>${esc(f)}</code>`).join(' ')}</p>
<div class="scroll"><table><tr><th>Field</th><th>Before</th><th>After</th></tr>
${ordered.slice(0, 8).map((f) => `<tr><td><code>${esc(f)}</code></td>
<td>${esc(JSON.stringify(d.prev.raw && d.prev.raw[f]) || '—').slice(0, 180)}</td>
<td>${esc(JSON.stringify(d.cur.raw && d.cur.raw[f]) || '—').slice(0, 180)}</td></tr>`).join('')}
</table></div></div>`;
}).join('') : `<p class="muted">One observation recorded so far. Differences appear here once a
second observation differs from the first.</p>`}

<h2>Correction</h2>
<p class="muted">If you maintain this extension and believe anything above is inaccurate,
<a href="/drift/policy">request a correction</a>. Corrections are published, and disputed
entries are marked as disputed while under review.</p>`;

      res.send(layout({
        title: `${r.displayName || r.name || slug} — observation record — TheBotique`,
        description: `Observation history for ${slug} on ${LABEL[source] || source}: version, source repository status and recorded changes, as observed ${day(latest.fetched_at)}.`,
        canonical: `${SITE}/drift/x/${source}/${encodeURIComponent(slug)}`,
        noindex: thin,
        jsonld: {
          '@context': 'https://schema.org', '@type': 'SoftwareApplication',
          name: r.displayName || r.name || slug,
          identifier: slug,
          applicationCategory: 'DeveloperApplication',
          softwareVersion: latest.version || undefined,
          description: (r.summary || r.description || '').slice(0, 300) || undefined,
          codeRepository: latest.repo_url || undefined,
          license: r.license || undefined,
          url: `${SITE}/drift/x/${source}/${encodeURIComponent(slug)}`
        },
        body
      }));
    } catch (e) { next(e); }
  });

  // --- measured reports -----------------------------------------------------
  // One parameterized route for every report, so adding a report costs no
  // route budget. Figures are computed from stored observations at request
  // time and never hardcoded.
  router.get('/drift/reports/:slug', async (req, res, next) => {
    try {
      const build = REPORTS[req.params.slug];
      if (!build) return next();
      const r = await build(db);
      if (!r) return next();
      res.send(layout({
        title: `${r.metaTitle} — TheBotique`,
        description: r.description,
        canonical: `${SITE}/drift/reports/${req.params.slug}`,
        jsonld: jsonldFor(req.params.slug, r),
        body: `<h1>${r.title}</h1>${r.body}`
      }));
    } catch (e) { next(e); }
  });

  // --- methodology (published before any finding, by design) ----------------
  router.get('/drift/methodology', (req, res) => {
    res.send(layout({
      title: 'Methodology — TheBotique',
      description: 'How TheBotique collects observations, what it records, what it deliberately does not claim, and the known limitations.',
      canonical: `${SITE}/drift/methodology`,
      body: `
<h1>Methodology</h1>
<p class="lede">What we collect, how, and what we deliberately do not claim. Version 1, ${new Date().toISOString().slice(0, 10)}.</p>

<h2>What we do</h2>
<p>Once a day we read the public APIs of five registries &mdash; the official MCP Registry,
ClawHub, Smithery and the npm registry (both search and per-package documents) &mdash; and record a
normalized copy of each extension&rsquo;s published record. We compute a SHA-256 hash over that
normalized record. When the hash differs from the previous observation, we store a new
observation. Identical re-reads are not stored.</p>

<h2>What we record</h2>
<ul class="plain">
<li>Identifier, published version, description and declared source repository.</li>
<li>For npm packages: the upstream content integrity hash, lifecycle scripts that run at
install time, declared dependencies, accounts holding publish rights, and declared license.</li>
<li>The UTC timestamp of every observation.</li>
</ul>

<h2>What we exclude, and why</h2>
<p>Counters that move constantly &mdash; download totals, install counts, usage figures &mdash; are
recorded but deliberately excluded from the hash. Including them would make every daily read
look like a change and render the entire record meaningless. Verified: an immediate second
collection run across all sources produced zero changes.</p>

<h2>What we do not claim</h2>
<p>We do not label extensions as abandoned, dead, malicious, safe or verified, and we publish no
composite score. Those are conclusions; we publish the timestamped observation that a reader can
use to reach their own. &ldquo;No issues detected&rdquo; would mean nothing here, so we never say it:
absence of a recorded change is not evidence of safety. We do not execute, sandbox or
behaviourally analyse any extension.</p>

<h2>Known limitations</h2>
<ul class="plain">
<li>We observe what registries publish. If a registry&rsquo;s record is wrong or stale, ours inherits that.</li>
<li>Registry search payloads carry descriptions but not permissions. Changes visible only inside
package contents are captured for npm packages and not yet for other sources.</li>
<li>A repository URL returning 404 may mean deleted, renamed or made private. We report the
observation, not the cause. When we sampled 120 MCP Registry listings, all 36 non-resolving
repositories were re-checked authenticated and following redirects; 36 of 36 still did not resolve.</li>
<li>Coverage is a subset of each registry, bounded by page limits, and grows over time.</li>
<li>The archive begins on the date shown on the overview page. We cannot report on anything before it.</li>
</ul>`
    }));
  });

  // --- corrections & right of reply ----------------------------------------
  router.get('/drift/policy', (req, res) => {
    res.send(layout({
      title: 'Corrections, disputes and right of reply — TheBotique',
      description: 'How to request a correction, how disputes are handled, and the disclosure approach for TheBotique.',
      canonical: `${SITE}/drift/policy`,
      body: `
<h1>Corrections, disputes and right of reply</h1>
<p class="lede">Every record here concerns software published by real people. This page explains
how to get something changed.</p>

<h2>Requesting a correction</h2>
<p>Email <a href="mailto:corrections@thebotique.ai">corrections@thebotique.ai</a> with the page URL
and what you believe is inaccurate. We aim to acknowledge within 72 hours. If you maintain the
extension, say so and we will publish your response alongside the record if you want us to.</p>

<h2>What a correction can produce</h2>
<ul class="plain">
<li><strong>Correction</strong> &mdash; the record is fixed and the change is noted publicly.</li>
<li><strong>Disputed</strong> &mdash; the record stands but is marked as disputed with your objection shown, while we check.</li>
<li><strong>Removal</strong> &mdash; the record is withdrawn where it should not have been published.</li>
<li><strong>Name removal</strong> &mdash; we will replace a maintainer name with &ldquo;maintainer&rdquo; on request while keeping the repository-level facts.</li>
</ul>
<p class="muted">Corrections are logged publicly. A visible correction record is how a reader
judges whether to trust anything else here.</p>

<h2>Disclosure approach</h2>
<ul class="plain">
<li><strong>Observable facts</strong> (version changes, commit age, declared install scripts) are published as collected. There is nothing to embargo about a public version number.</li>
<li><strong>Anything suggestive but unconfirmed</strong> is published as the neutral observation only, without any characterisation of intent, and we notify the maintainer.</li>
<li><strong>Anything appearing to be an active attack on users</strong> is reported to the registry and the hosting platform first.</li>
</ul>

<h2>Data about people</h2>
<p>We store publicly published maintainer handles and profile URLs so that a change in publish
rights is visible. We do not store commit-author email addresses. To object to processing of your
personal data, email the address above.</p>`
    }));
  });

  // --- sitemap: only pages with something measured on them ------------------
  // Owns /sitemap.xml as well. The old one advertised 17 marketplace URLs
  // including six category pages that are provably empty -- telling Google
  // to index a dead storefront while the real corpus went unlisted.
  router.get(['/sitemap.xml', '/drift/sitemap.xml'], async (req, res, next) => {
    try {
      const rows = (await q(
        `SELECT source, slug, max(fetched_at) last, count(*)::int obs,
                bool_or(repo_url IS NOT NULL) hasrepo
           FROM artifact_snapshots GROUP BY source, slug
          HAVING count(*) > 1 OR bool_or(repo_url IS NOT NULL)
          ORDER BY max(fetched_at) DESC LIMIT 40000`
      )).rows;
      const urls = [
        { loc: SITE, last: new Date() },
        { loc: `${SITE}/drift`, last: new Date() },
        { loc: `${SITE}/drift/changes`, last: new Date() },
        { loc: `${SITE}/drift/methodology`, last: new Date() },
        { loc: `${SITE}/drift/policy`, last: new Date() },
        { loc: `${SITE}/drift/pricing`, last: new Date() },
        // Root paths only. A sitemap is a list of pages you want indexed --
        // listing a URL that 301s gets it reported as "Page with redirect,"
        // which is not an index entry, it is a defect report.
        { loc: `${SITE}/verify`, last: new Date() },
        { loc: `${SITE}/log`, last: new Date() },
        { loc: `${SITE}/tamper`, last: new Date() },
        { loc: `${SITE}/join`, last: new Date() },
        { loc: `${SITE}/about`, last: new Date() },
        { loc: `${SITE}/rules`, last: new Date() },
        { loc: `${SITE}/terms`, last: new Date() },
        { loc: `${SITE}/privacy`, last: new Date() },
        { loc: `${SITE}/operators`, last: new Date() },
        { loc: `${SITE}/moderations`, last: new Date() },
        { loc: `${SITE}/extensions`, last: new Date() },
        { loc: `${SITE}/mcp-setup`, last: new Date() },
        ...INDEX.map((i) => ({ loc: `${SITE}/drift/reports/${i[0]}`, last: new Date() })),
        ...rows.map((r) => ({
          loc: `${SITE}/drift/x/${r.source}/${encodeURIComponent(r.slug)}`, last: r.last
        }))
      ];
      res.type('application/xml').send(
        `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
        urls.map((u) => `<url><loc>${esc(u.loc)}</loc><lastmod>${day(u.last)}</lastmod></url>`).join('\n') +
        `\n</urlset>`
      );
    } catch (e) { next(e); }
  });

  // --- RSS: cheap, and NLWeb-class tooling actually ingests it --------------
  router.get('/drift/feed.xml', async (req, res, next) => {
    try {
      const rows = (await q(
        `SELECT source, slug, max(fetched_at) last, count(*)::int obs
           FROM artifact_snapshots GROUP BY source, slug HAVING count(*) > 1
          ORDER BY max(fetched_at) DESC LIMIT 50`
      )).rows;
      res.type('application/rss+xml').send(
        `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel>
<title>TheBotique — recorded changes</title>
<link>${SITE}/drift/changes</link>
<description>AI agent extensions whose published record changed between daily observations.</description>` +
        rows.map((r) => {
          const link = `${SITE}/drift/x/${r.source}/${encodeURIComponent(r.slug)}`;
          return `<item><title>${esc(r.slug)} changed (${esc(LABEL[r.source] || r.source)})</title>
<link>${esc(link)}</link><guid isPermaLink="false">${esc(link)}#${r.obs}</guid>
<pubDate>${new Date(r.last).toUTCString()}</pubDate>
<description>${esc(`${r.obs} observations recorded; most recent difference ${iso(r.last)}.`)}</description></item>`;
        }).join('') +
        `</channel></rss>`
      );
    } catch (e) { next(e); }
  });

  require('../board/routes').mount(router, db);
  require('../board/tamper').mount(router);
  require('../board/pages').mount(router);
  require('../board/discovery').mount(router, db);
  require('../board/mcp').mount(router, db);
  require('../sigil/routes').mount(router);
  require('../sigil/skill').mount(router);
  require('../sigil/wellknown').mount(router);
  // Retired 2026-09-03. The gate, the readiness quiz and the clearance spec
  // belonged to directions that were researched and dropped, and having them
  // in the navigation is most of why this read as five separate products.
  // 301 rather than 404: they were linked publicly, and a redirect to the
  // thing that replaced them is better than a dead end.
  for (const gone of ['/gate', '/readiness', '/clearance-record']) {
    router.get(gone, (req, res) => res.redirect(301, '/'));
  }
  // Everything published under /sigil/* before the platform moved to the root.
  router.get(/^\/sigil(\/.*)?$/, (req, res) => {
    const tail = req.path.replace(/^\/sigil/, '') || '/';
    res.redirect(301, tail);
  });
  return router;
}

module.exports = { mount };
