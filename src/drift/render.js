'use strict';

// Shared layout and the whole visual system. One file, one stylesheet.
//
// ART DIRECTION: "The Record" — warm paper ground, oxblood used only for
// evidentiary marks, three typographic voices, hairline rules, marginalia.
//
// The previous version was near-black ground with a mint accent, one
// grotesque doing every job, rounded bordered cards, and unmanaged measure.
// That is the canonical AI-generated fingerprint and it was rejected on
// sight by a creative director, correctly. The deeper failure: this business
// sells documentary rigour and the page had no document sensibility at all —
// no rules, no folios, no tabular figures, no numbering, no measure control.
//
// Rules that must not be broken here:
//   - Light ground. Records are light ground: paper, filings, call sheets.
//   - No cards, no border-radius, no shadows, no gradients. Hairline rules
//     do the separating.
//   - Measure capped at 66ch. This single constraint does more for how
//     designed a page feels than anything else on the list.
//   - Three type roles, never one: serif display, civic sans text, mono
//     metadata. Prices in Courier — the native face of production paperwork,
//     which this audience reads without needing it explained.
//   - Accent under ~2% of pixels, only on dates, statutes and one CTA.
//     Never green or teal: that is the tell.
//   - Motion: essentially none. Motion signals startup; we want record.

const SITE = 'https://www.thebotique.ai';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const FONTS = 'https://fonts.googleapis.com/css2?family=Newsreader:opsz,wght@6..72,300;6..72,400;6..72,500&family=Public+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&family=Courier+Prime&display=swap';

const CSS = `
:root{
  --paper:#F7F4EE; --ink:#161412; --ink-2:#57534E; --rule:#D8D2C6;
  --accent:#9B2C1F;
  --serif:"Newsreader",Georgia,"Times New Roman",serif;
  --sans:"Public Sans",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  --mono:"IBM Plex Mono",ui-monospace,Menlo,monospace;
  --courier:"Courier Prime","Courier New",monospace;
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{
  margin:0;background:var(--paper);color:var(--ink);
  font-family:var(--sans);font-size:19px;line-height:1.6;
  font-variant-numeric:tabular-nums;-webkit-font-smoothing:antialiased;
}
.skip{position:absolute;left:-9999px}
.skip:focus{left:8px;top:8px;background:var(--paper);padding:8px 12px;z-index:10;outline:2px solid var(--accent)}

.sheet{max-width:1080px;margin:0 auto;padding:0 28px 96px}
.band{display:grid;grid-template-columns:minmax(0,66ch) 1fr;gap:0 40px;align-items:start}
.band > .margin{font-family:var(--mono);font-size:13px;line-height:1.5;color:var(--ink-2);
  letter-spacing:.02em;padding-top:.55em}

header.site{border-bottom:1px solid var(--ink);margin-bottom:44px;padding:22px 0 12px;
  display:flex;justify-content:space-between;align-items:baseline;gap:20px;flex-wrap:wrap}
.wordmark{font-family:var(--serif);font-size:21px;font-weight:500;letter-spacing:.14em;
  text-transform:uppercase;color:var(--ink);text-decoration:none;border:0}
header.site nav{font-family:var(--mono);font-size:12px;letter-spacing:.08em;text-transform:uppercase}
header.site nav a{margin-left:20px;color:var(--ink-2);text-decoration:none;border-bottom:1px solid transparent}
header.site nav a:hover{color:var(--ink);border-bottom-color:var(--accent);background:none}

a{color:var(--ink);text-decoration:none;border-bottom:1px solid var(--accent);transition:background 120ms}
a:hover{background:rgba(155,44,31,.08)}

h1{font-family:var(--serif);font-weight:300;font-size:clamp(34px,5.2vw,60px);line-height:1.08;
  letter-spacing:-.021em;margin:0 0 22px;text-wrap:balance;max-width:20ch}
h2{font-family:var(--serif);font-weight:400;font-size:27px;line-height:1.2;letter-spacing:-.012em;
  margin:56px 0 4px;padding-top:14px;border-top:1px solid var(--rule);text-wrap:balance}
h2 .num{font-family:var(--mono);font-size:12px;color:var(--accent);letter-spacing:.1em;
  display:block;margin-bottom:9px;font-weight:500}
p{margin:0 0 17px;max-width:66ch;text-wrap:pretty}
.lede{font-family:var(--serif);font-size:22px;line-height:1.48;margin-bottom:30px;max-width:60ch}
.note,.muted{color:var(--ink-2);font-size:16px}
strong{font-weight:600}

.pull{border-left:2px solid var(--accent);padding:2px 0 2px 22px;margin:34px 0;
  font-family:var(--serif);font-size:20px;line-height:1.5;max-width:58ch}

.scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;margin:0 0 20px}
table{width:100%;border-collapse:collapse;font-size:16px;min-width:520px}
caption{text-align:left;font-family:var(--mono);font-size:12px;letter-spacing:.08em;
  text-transform:uppercase;color:var(--ink-2);padding-bottom:9px}
th{font-family:var(--mono);font-size:11.5px;letter-spacing:.09em;text-transform:uppercase;
  color:var(--ink-2);font-weight:500;text-align:left;vertical-align:bottom;
  padding:0 16px 8px 0;border-bottom:1px solid var(--ink)}
td{padding:13px 16px 13px 0;border-bottom:1px solid var(--rule);vertical-align:top}
td:last-child,th:last-child{padding-right:0}
.price{font-family:var(--courier);font-size:15px;white-space:nowrap}

dl.kv{display:grid;grid-template-columns:minmax(140px,auto) 1fr;gap:0;margin:0 0 22px;font-size:16px;max-width:66ch}
dl.kv dt{font-family:var(--mono);font-size:11.5px;letter-spacing:.08em;text-transform:uppercase;
  color:var(--ink-2);padding:11px 20px 11px 0;border-top:1px solid var(--rule)}
dl.kv dd{margin:0;padding:11px 0;border-top:1px solid var(--rule);word-break:break-word}

ul.plain{padding-left:0;list-style:none;max-width:66ch;margin:0 0 18px}
ul.plain li{padding:9px 0 9px 26px;border-bottom:1px solid var(--rule);position:relative}
ul.plain li:before{content:"—";position:absolute;left:0;color:var(--accent)}

code,.mono{font-family:var(--mono);font-size:.88em;background:rgba(22,20,18,.045);padding:1px 5px}
.obs,.stamp{display:inline-block;font-family:var(--mono);font-size:11.5px;letter-spacing:.07em;
  text-transform:uppercase;color:var(--ink-2);border:1px solid var(--rule);padding:4px 10px}
.date{color:var(--accent);font-weight:600}

.cta{display:inline-block;font-family:var(--mono);font-size:13px;letter-spacing:.09em;
  text-transform:uppercase;color:var(--paper)!important;background:var(--accent);
  padding:13px 22px;border:0;cursor:pointer;text-decoration:none}
.cta:hover{background:#7d2318}

/* The old markup used .card everywhere. Neutralised rather than deleted so no
   page breaks while copy is being rewritten: it is now a ruled block, not a box. */
.card{border:0;border-top:1px solid var(--rule);border-bottom:1px solid var(--rule);
  padding:18px 0;margin:0 0 20px;background:none;max-width:66ch}

footer.site{margin-top:76px;border-top:1px solid var(--ink);padding-top:16px;
  color:var(--ink-2);font-size:14px;max-width:66ch}
footer.site .colophon{font-family:var(--mono);font-size:11.5px;letter-spacing:.06em;
  text-transform:uppercase;margin-top:10px}

:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
@media (max-width:820px){
  body{font-size:18px}
  .band{grid-template-columns:1fr}
  .band > .margin{padding:4px 0 14px;border-bottom:1px solid var(--rule);margin-bottom:16px}
  dl.kv{grid-template-columns:1fr}
  dl.kv dd{border-top:0;padding-top:0;padding-bottom:12px}
}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}

/* Print is a first-class deliverable: this audience forwards things to lawyers. */
@media print{
  @page{margin:20mm}
  body{background:#fff;color:#000;font-size:11pt}
  header.site nav,.cta,.skip{display:none}
  .sheet{max-width:none;padding:0}
  .band{display:block}
  .band > .margin{color:#444;border:0;padding:0 0 8px}
  a{border:0;color:#000}
  a[href^="http"]:after{content:" (" attr(href) ")";font-size:9pt;color:#555;word-break:break-all}
  table,dl.kv,.card{break-inside:avoid}
  h1,h2{break-after:avoid}
}
`;

function layout({ title, description, canonical, body, jsonld, noindex }) {
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description || '')}">
${noindex ? '<meta name="robots" content="noindex,follow">' : ''}
${canonical ? `<link rel="canonical" href="${esc(canonical)}">` : ''}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${FONTS}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description || '')}">
<meta property="og:type" content="website">
${canonical ? `<meta property="og:url" content="${esc(canonical)}">` : ''}
<style>${CSS}</style>
${jsonld ? `<script type="application/ld+json">${JSON.stringify(jsonld).replace(/</g, '\\u003c')}</script>` : ''}
</head><body>
<a class="skip" href="#main">Skip to content</a>
<div class="sheet">
<header class="site">
<a class="wordmark" href="/">TheBotique</a>
<nav><a href="/sigil">Sigil</a><a href="/gate">The gate</a><a href="/readiness">Readiness check</a><a href="/drift">Research archive</a></nav>
</header>
<main id="main">
${body}
</main>
<footer class="site">
Nothing here is legal advice. Our research archive publishes observations of public data at
the timestamp shown &mdash; never a certification, and never an assessment of any person.
See its <a href="/drift/methodology">methodology</a> and
<a href="/drift/policy">corrections policy</a>.
<div class="colophon">TheBotique &middot; <a href="mailto:hello@thebotique.ai">hello@thebotique.ai</a></div>
</footer>
</div></body></html>`;
}

function repoObservation(row) {
  if (!row.repo_url) return 'No source repository listed';
  if (row.repo_status === 'gone') return 'Source URL did not resolve when last checked';
  if (row.repo_status === 'stale') return 'No commits to the default branch in over 90 days';
  if (row.repo_status === 'alive') return 'Commits observed in the last 90 days';
  return 'Source repository not yet checked';
}

const iso = (d) => (d ? new Date(d).toISOString().replace('.000Z', 'Z') : null);
const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');

function changedFields(a, b) {
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  const out = [];
  for (const k of keys) {
    if (JSON.stringify(a && a[k]) !== JSON.stringify(b && b[k])) out.push(k);
  }
  return out.sort();
}

const CONSEQUENTIAL = new Set([
  'scripts', 'dependencies', 'maintainers', 'integrity', 'repository',
  'permissions', 'remotes', 'packages', 'license', 'owner', 'deprecated', 'homepage'
]);

module.exports = { esc, layout, repoObservation, changedFields, CONSEQUENTIAL, iso, day, SITE };
