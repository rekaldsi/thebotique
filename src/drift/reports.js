'use strict';

// Measured reports.
//
// Every figure is computed from stored observations at request time and
// never hardcoded, so the page and the database cannot disagree. Each
// report states its sample size, its method, and what it does NOT say --
// the last of those is the part that keeps this publishable.

const { esc, SITE } = require('../sigil/wire');
const { day } = require('./render');

const DISCLAIM = `<p class="muted">Full method and known limitations:
<a href="/drift/methodology">methodology</a>. Believe a specific record is wrong?
<a href="/drift/policy">Request a correction</a>.</p>`;

function table(rows) {
  return `<div class="scroll"><table><tr><th>Observation</th><th>Count</th><th>Share</th></tr>
${rows.map((r) => `<tr><td>${r[3] ? `<strong>${r[0]}</strong>` : r[0]}</td>
<td>${r[3] ? `<strong>${r[1]}</strong>` : r[1]}</td><td>${r[3] ? `<strong>${r[2]}</strong>` : r[2]}</td></tr>`).join('')}
</table></div>`;
}

const pct = (k, n) => (n ? `${Math.round((k / n) * 1000) / 10}%` : '0%');
const num = (v) => Number(v || 0).toLocaleString();

// --- 1. source repository liveness -----------------------------------------
async function repositoryLiveness(db) {
  const m = await require('../collector/repocheck').measure(db);
  if (!m.total) return null;
  return {
    title: 'How many listed agent extensions still have a working source repository?',
    metaTitle: 'Source repository liveness across listed agent extensions',
    description: `Measured: ${m.pctGone}% of sampled agent extension listings point at a source URL that did not resolve; ${m.pctNotHealthy}% are neither recently updated nor resolving (n=${m.total}).`,
    n: m.total,
    body: `
<p class="lede">A recurring claim in 2026 is that roughly half of published MCP servers are
&ldquo;dead&rdquo;. We measured it against our own corpus rather than repeat it.</p>
<span class="obs">n = ${num(m.total)} &middot; measured ${esc(day(new Date()))} &middot; recomputed on every page load</span>
<h2>Result</h2>
${table([
  ['Commits observed in the last 90 days', num(m.alive), `${m.pctAlive}%`],
  ['No commits in over 90 days', num(m.stale), `${m.pctStale}%`],
  ['Source URL did not resolve', num(m.gone), `${m.pctGone}%`],
  ['Neither recently updated nor resolving', num(m.stale + m.gone), `${m.pctNotHealthy}%`, true]
])}
<h2>What this does and does not say</h2>
<p>It says ${m.pctGone}% of sampled listings point at a source URL that did not resolve when
checked, and a further ${m.pctStale}% point at repositories with no commits in over 90 days.
It does <strong>not</strong> say those projects are abandoned, unmaintained or unsafe. A URL that
does not resolve may have been deleted, renamed, or made private. Stable software may need no
commits. We report the observation; the inference is yours.</p>
<h2>Method</h2>
<ul class="plain">
<li>Sample drawn at random from artifacts publishing a source repository URL. Random selection
matters: listings are not evenly distributed across the alphabet, and an alphabetically ordered
scan of this same corpus reported a non-resolving rate of 72% &mdash; roughly triple the
random-sample figure. That is a sampling artifact. We mention it because it is an easy way to
publish a wrong number, and because we made exactly that mistake first.</li>
<li>Queried through the GitHub API with authentication where available. An unauthenticated
request returns 404 for private repositories as well as deleted ones, which would report live
projects as gone.</li>
<li>Renames are followed rather than counted as failures. Rate-limited checks are skipped, never
recorded as failures.</li>
<li>Threshold for &ldquo;no recent commits&rdquo; is 90 days since the last push to the default branch.</li>
</ul>
<h2>Independent replication</h2>
<p>An earlier ad-hoc audit of 120 repositories drawn only from the official MCP Registry, run
through entirely separate code, found 62.0% with recent commits and 37.0% neither recently
updated nor resolving. This pipeline, on a larger and differently composed sample, finds
${m.pctAlive}% and ${m.pctNotHealthy}%. In that earlier audit every non-resolving repository was
re-checked authenticated and following redirects; 36 of 36 still did not resolve.</p>
${DISCLAIM}`
  };
}

// --- 2. install-time code execution ----------------------------------------
async function installTimeCode(db) {
  const r = await db.query(
    `SELECT count(*)::int total,
            count(*) FILTER (WHERE raw->'scripts' ? 'postinstall')::int post,
            count(*) FILTER (WHERE raw->'scripts' ? 'preinstall')::int pre,
            count(*) FILTER (WHERE raw->'scripts' ? 'install')::int inst,
            count(*) FILTER (WHERE raw->'scripts' ? 'prepare')::int prep,
            count(*) FILTER (WHERE jsonb_array_length(coalesce(raw->'maintainers','[]'::jsonb)) > 1)::int multi
       FROM (SELECT DISTINCT ON (slug) slug, raw FROM artifact_snapshots
              WHERE source = 'npm-deep' ORDER BY slug, fetched_at DESC) t`
  );
  const x = r.rows[0];
  if (!x || !x.total) return null;
  const anyInstall = x.post + x.pre + x.inst;
  return {
    title: 'How many agent-related npm packages run code when you install them?',
    metaTitle: 'Install-time code execution in agent-related npm packages',
    description: `Measured across ${x.total} of the most-downloaded agent-related npm packages: ${pct(anyInstall, x.total)} declare a lifecycle script that executes on the installing machine at install time.`,
    n: x.total,
    body: `
<p class="lede">Installing a package can run code on your machine before you ever import it.
This is ordinary and usually benign. It is also the point at which a change matters most.</p>
<span class="obs">n = ${num(x.total)} &middot; measured ${esc(day(new Date()))} &middot; recomputed on every page load</span>
<h2>Result</h2>
${table([
  ['Declares <code>postinstall</code>', num(x.post), pct(x.post, x.total)],
  ['Declares <code>preinstall</code>', num(x.pre), pct(x.pre, x.total)],
  ['Declares <code>install</code>', num(x.inst), pct(x.inst, x.total)],
  ['Any of the three (runs code at install)', num(anyInstall), pct(anyInstall, x.total), true],
  ['Declares <code>prepare</code> (runs on local installs)', num(x.prep), pct(x.prep, x.total)],
  ['More than one account holds publish rights', num(x.multi), pct(x.multi, x.total)]
])}
<h2>Why this is worth recording</h2>
<p>A lifecycle script is a factual property of a published package, declared openly in its
manifest. Most exist to compile a binary or set up a git hook. The reason we record it is that
it is the field whose <em>change</em> carries the most consequence: a package that did not run
code at install time and now does has altered what installing it does, on every machine that
updates. That is observable, and until now nobody was watching it over time.</p>
<h2>What this does and does not say</h2>
<p>It does <strong>not</strong> say any of these packages are unsafe, and we make no claim about
what any individual script does. Declaring a postinstall hook is a normal and widespread
practice. This is a base rate, published so that a change against it is legible.</p>
<h2>Method</h2>
<ul class="plain">
<li>Drawn from the npm package document (not the search endpoint, which omits these fields
entirely) for the most-downloaded agent-related packages, plus every package already observed to
declare an install hook, so that the highest-consequence set never falls out of coverage.</li>
<li>Counts are of <em>declared</em> lifecycle scripts. We do not execute, sandbox or analyse them.</li>
<li><code>prepare</code> is counted separately because it runs on local and git installs rather
than on a normal registry install, so it is a materially different exposure.</li>
</ul>
${DISCLAIM}`
  };
}

// --- 3. adoption distribution ----------------------------------------------
async function adoptionDistribution(db) {
  const r = await db.query(
    `SELECT installs FROM (SELECT DISTINCT ON (slug) slug, installs
       FROM artifact_snapshots WHERE source = 'clawhub' AND installs IS NOT NULL
       ORDER BY slug, fetched_at DESC) t`
  );
  const v = r.rows.map((x) => Number(x.installs)).sort((a, b) => b - a);
  const n = v.length;
  if (!n) return null;
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const zero = v.filter((x) => x === 0).length;
  const lt5 = v.filter((x) => x < 5).length;
  const ge100 = v.filter((x) => x >= 100).length;
  const topShare = sum(v) ? Math.round((sum(v.slice(0, Math.ceil(n * 0.1))) / sum(v)) * 1000) / 10 : 0;
  return {
    title: 'How concentrated is adoption across published agent skills?',
    metaTitle: 'Adoption distribution across published agent skills',
    description: `Measured across ${n} published agent skills: ${pct(zero, n)} report zero installs, ${pct(lt5, n)} report fewer than five, and the top 10% account for ${topShare}% of all reported installs.`,
    n,
    body: `
<p class="lede">Registry listing counts are widely quoted as a measure of ecosystem health.
They measure publishing, not use. Here is the difference, in one corpus.</p>
<span class="obs">n = ${num(n)} &middot; measured ${esc(day(new Date()))} &middot; recomputed on every page load</span>
<h2>Result</h2>
${table([
  ['Reports zero installs', num(zero), pct(zero, n)],
  ['Reports fewer than five installs', num(lt5), pct(lt5, n), true],
  ['Reports 100 or more installs', num(ge100), pct(ge100, n)],
  ['Highest install count observed', num(v[0]), '—'],
  ['Median install count', num(v[Math.floor(n / 2)]), '—'],
  ['Share of all installs held by the top 10%', `${topShare}%`, '—']
])}
<h2>What this does and does not say</h2>
<p>It says reported adoption is extremely concentrated: a median listing reports
${num(v[Math.floor(n / 2)])} installs while the top tenth accounts for ${topShare}% of the total.
It does <strong>not</strong> say the long tail is low quality, unmaintained or abandoned. New,
niche, private-use and personal skills all legitimately report low counts, and a count of zero
may simply mean the registry does not track installs for that listing.</p>
<h2>Why it matters here</h2>
<p>It is the reason we do not attempt to watch everything. Monitoring effort is directed at
what people actually install, because watching a listing nobody uses protects nobody.</p>
<h2>Method</h2>
<ul class="plain">
<li>Install counts are as self-reported by the registry. We record them; we do not verify them.</li>
<li>Latest observation per listing. Listings that report no install figure at all are excluded.</li>
<li>No individual listing is named in this report.</li>
</ul>
${DISCLAIM}`
  };
}

const REPORTS = {
  'source-repository-liveness': repositoryLiveness,
  'install-time-code-execution': installTimeCode,
  'adoption-distribution': adoptionDistribution
};

const INDEX = [
  ['source-repository-liveness', 'How many listed agent extensions still have a working source repository?'],
  ['install-time-code-execution', 'How many agent-related npm packages run code when you install them?'],
  ['adoption-distribution', 'How concentrated is adoption across published agent skills?']
];

function jsonldFor(slug, r) {
  return {
    '@context': 'https://schema.org', '@type': 'Dataset',
    name: r.metaTitle, description: r.description,
    url: `${SITE}/drift/reports/${slug}`, isAccessibleForFree: true,
    creator: { '@type': 'Organization', name: 'TheBotique', url: SITE }
  };
}

module.exports = { REPORTS, INDEX, jsonldFor };
