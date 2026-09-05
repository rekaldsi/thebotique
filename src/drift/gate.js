'use strict';

// A working demonstration of a pre-publication creative governance gate.
//
// WHY THIS EXISTS: every vendor in this category sells behind "book a demo."
// Red Marker, Sedric, PerformLine, ComplyAuto -- not one publishes a price and
// not one lets you see the thing work without talking to sales. That is the
// gap this page attacks. You can watch it run, right now, without giving
// anyone your email.
//
// The rules actually execute. The pattern list below is really matched against
// the ad copy; the offer dates are really compared against the release date.
// Nothing here is a screenshot or a mock.
//
// The fourth example is the point of the whole page. It passes the input gate
// and the output gate -- a human approved it, correctly, on the 12th -- and is
// then stopped at the release gate on the 31st because the offer it advertises
// expired on the 28th. Re-validating at RELEASE rather than inheriting an
// approval granted weeks earlier is the one primitive that appears in no
// competitor's published feature set. It is also the failure that actually
// happens: nobody ships a deliberately non-compliant ad, they ship one that
// was compliant when it was approved.

const { esc, layout, SITE } = require('./render');

// --- the claims library -------------------------------------------------
// Everything below is an INVENTED example. "Meridian" is a fictional
// direct-to-consumer brand, its figures are made up, and no real company's
// claims, offers, regions or file conventions appear anywhere on this page.
// That is deliberate: a demonstration of a review system should never be a
// place where somebody's actual approved-claims list gets published.
//
// The category is consumer packaged goods because FTC substantiation applies
// to everyone, the rules are public, and nobody has to explain them.

const CLAIMS = [
  { id: 'clinical', text: 'In a 12-week company-funded study of 84 adults, participants reported improved sleep onset',
    source: 'Meridian Study MRD-2026-04, on file',
    verifier: 'Regulatory', on: '2026-06-02',
    patterns: ['clinically', 'clinical', 'proven', 'study shows', 'scientifically'] },
  { id: 'origin', text: 'Ingredients sourced from certified suppliers in three countries',
    source: 'Meridian supplier certification pack, 2026 revision',
    verifier: 'Regulatory', on: '2026-05-18',
    patterns: ['single origin', 'locally sourced', 'farm to', 'sustainably sourced'] },
  { id: 'compare', text: 'Contains 400mg per serving; competitor products range from 150mg to 500mg',
    source: 'Meridian competitive panel review, June 2026',
    verifier: 'Regulatory', on: '2026-06-11',
    patterns: ['strongest', 'most powerful', 'more than any', 'best in class', 'number one', '#1'] }
];

// --- the offer, bound to a source document ------------------------------
const OFFERS = {
  'PROMO-AUG': {
    id: 'PROMO-AUG', headline: '30% off first subscription',
    contract: 'promo_august_2026_v2.json', locked: true,
    termStart: '2026-08-01', termEnd: '2026-08-28',
    regions: ['US-East', 'US-West', 'CA'], eligibility: 'New subscribers only',
    killSwitch: 'green',
    disclaimer: '30% off applies to first subscription order only. New subscribers only. Auto-renews at full price; cancel any time before renewal. Excludes taxes and shipping. Offer ends 8/28/2026.'
  },
  'PROMO-SEP': {
    id: 'PROMO-SEP', headline: '25% off first subscription',
    contract: 'promo_september_2026_v1.json', locked: true,
    termStart: '2026-08-29', termEnd: '2026-09-30',
    regions: ['US-East', 'US-West', 'CA'], eligibility: 'New subscribers only',
    killSwitch: 'green',
    disclaimer: '25% off applies to first subscription order only. New subscribers only. Auto-renews at full price; cancel any time before renewal. Excludes taxes and shipping. Offer ends 9/30/2026.'
  }
};

// --- the work under review ----------------------------------------------
const ADS = [
  { id: 'clean', label: 'A clean one',
    note: 'Everything traces. This is what passing looks like.',
    region: 'US-East', vehicle: 'Meridian Nightly', channel: 'social 1:1',
    approved: '2026-08-29', release: '2026-08-31', offer: 'PROMO-SEP',
    copy: 'Some nights take longer than others. Meridian Nightly is there for the ones that do. 25% off your first subscription.',
    disclaimerUsed: OFFERS['PROMO-SEP'].disclaimer, cited: [] },
  { id: 'claim', label: 'An unverified claim',
    note: 'The writer reached for a word that sounds like evidence. The library holds what the evidence actually says, and it is narrower.',
    region: 'US-East', vehicle: 'Meridian Nightly', channel: 'social 1:1',
    approved: '2026-08-29', release: '2026-08-31', offer: 'PROMO-SEP',
    copy: 'Clinically proven to help you fall asleep faster. Meridian Nightly. 25% off your first subscription.',
    disclaimerUsed: OFFERS['PROMO-SEP'].disclaimer, cited: [] },
  { id: 'disclaimer', label: 'An offer with no terms',
    note: 'A discount and an auto-renewing subscription in the same sentence, with none of the terms that have to travel with them.',
    region: 'US-East', vehicle: 'Meridian Nightly', channel: 'social 1:1',
    approved: '2026-08-29', release: '2026-08-31', offer: 'PROMO-SEP',
    copy: 'Get 25% off your first Meridian subscription. Start tonight.',
    disclaimerUsed: '', cited: [] },
  { id: 'expired', label: 'Approved, then expired',
    note: 'This one is the reason the page exists. Somebody reviewed it and approved it, correctly, on 12 August. Nothing about the creative changed. It fails anyway.',
    region: 'US-East', vehicle: 'Meridian Nightly', channel: 'social 1:1',
    approved: '2026-08-12', release: '2026-08-31', offer: 'PROMO-AUG',
    copy: 'Some nights take longer than others. Meridian Nightly is there for the ones that do. 30% off your first subscription.',
    disclaimerUsed: OFFERS['PROMO-AUG'].disclaimer, cited: [] }
];

const REGIONS = ['US-East', 'US-West', 'CA', 'UK', 'EU'];
const VEHICLES = ['Meridian Nightly', 'Meridian Daily', 'Meridian Reset'];

// --- the gates, which really run ----------------------------------------
function evaluate(ad, claims, offers) {
  claims = claims || CLAIMS;
  offers = offers || OFFERS;
  const offer = offers[ad.offer] || null;
  const text = ad.copy.toLowerCase();
  const gates = [];

  // Gate 01 -- before generation
  const g1 = [];
  const knownRegions = new Set(Object.values(offers).flatMap((o) => o.regions || []));
  const regionOk = !!ad.region && (knownRegions.size === 0 || !offer || (offer.regions || []).length === 0 || knownRegions.has(ad.region));
  g1.push({ ok: regionOk, name: 'Where this runs is decided, not assumed',
    detail: ad.region
      ? `${ad.region}. Offers, disclaimers and eligibility all differ by market, so the answer is established before anything is written rather than discovered at the end.`
      : 'No market set. Everything downstream — which offer is valid, which disclaimer must run — depends on this, so it cannot be left blank.' });
  const offerResolved = !!offer || ad.offerDeclared === true;
  g1.push({ ok: offerResolved, name: 'An offer is attached, or "none" is explicit',
    detail: offer
      ? `${offer.id} — ${offer.headline}, from ${offer.contract}`
      : (ad.offerDeclared
        ? 'Declared as brand work with no offer. That is a decision, recorded — which is the point. An offer nobody decided about is the one that ships attached to the wrong disclaimer.'
        : 'No offer attached and none declared. Ambiguity here is how the wrong disclaimer gets fitted later.') });
  gates.push({ n: '01', when: 'Before generation', purpose: 'Stop work that cannot be cleared however good it turns out.', checks: g1 });

  // Gate 02 -- before approval
  const g2 = [];
  const tripped = [];
  for (const c of claims) {
    for (const p of c.patterns) {
      if (text.includes(p)) { tripped.push({ claim: c, pattern: p }); break; }
    }
  }
  if (tripped.length === 0) {
    g2.push({ ok: true, name: 'No claim-shaped language present', detail: 'Nothing in the copy trips the pattern list, so there is nothing to substantiate.' });
  } else {
    for (const t of tripped) {
      const substantiated = ad.cited.includes(t.claim.id);
      g2.push({
        ok: substantiated,
        name: substantiated ? `Claim traces to a verified source` : `Claim-shaped language with no verified source`,
        detail: substantiated
          ? `“${t.pattern}” → ${t.claim.text}. ${t.claim.source}. Verified by ${t.claim.verifier}, ${t.claim.on}.`
          : `The pattern “${t.pattern}” matched. The library holds a verified version — ${t.claim.text}, from ${t.claim.source}, verified by ${t.claim.verifier} on ${t.claim.on} — and the copy does not say that. Either say the verified thing or cut the line.`
      });
    }
  }
  const hasPayment = /(\$\s?\d|\d+\s?%\s?off|free trial|subscription)/i.test(ad.copy);
  if (hasPayment) {
    const verbatim = offer && ad.disclaimerUsed.trim() === offer.disclaimer.trim();
    g2.push({ ok: verbatim,
      name: verbatim ? 'Disclaimer present, in the ratified wording' : 'Payment stated without its ratified disclaimer',
      detail: verbatim
        ? 'Matches the text on the source contract character for character. The disclaimer is a property of the offer, not of the script — rewriting it to fit the layout is an edit to a legal instrument.'
        : 'A price, a discount or a subscription is a triggering term. Once it appears, the terms that qualify it have to travel with it — what renews, at what price, and how to stop it. The ratified text sits on the offer document and is not optional.' });
  }
  gates.push({ n: '02', when: 'Before approval', purpose: 'Establish that what was made is supportable, and write down what cannot be reconstructed later.', checks: g2 });

  // Gate 03 -- before release. The one nobody else ships.
  const g3 = [];
  if (offer) {
    const live = ad.release >= offer.termStart && ad.release <= offer.termEnd;
    g3.push({ ok: live,
      name: live ? 'Offer is still live on the release date' : 'Offer expired between approval and release',
      detail: live
        ? `${offer.id} runs ${offer.termStart} to ${offer.termEnd}. Releasing ${ad.release}.`
        : `${offer.id} ended ${offer.termEnd}. This was approved ${ad.approved}, when it was live, and is releasing ${ad.release} — ${Math.round((new Date(ad.release) - new Date(offer.termEnd)) / 86400000)} days after it expired. The creative did not change. The world did.` });
    g3.push({ ok: offer.killSwitch === 'green', name: 'Kill switch is green on the source contract', detail: `${offer.contract} — ${offer.killSwitch}` });
    const regionOkAtRelease = !offer.regions || offer.regions.length === 0 || offer.regions.includes(ad.region);
    g3.push({ ok: regionOkAtRelease, name: 'Offer is valid in this market',
      detail: (offer.regions && offer.regions.length)
        ? `${offer.id} is eligible in ${offer.regions.join(', ')}. Releasing into ${ad.region}.`
        : `${offer.id} carries no market restriction.` });
  } else {
    g3.push({ ok: true, name: 'No offer to re-validate', detail: 'Brand work with no offer attached.' });
  }
  gates.push({ n: '03', when: 'Before release', purpose: 'Re-check what was true at approval and may not be true today.', checks: g3 });

  return { gates, offer };
}


// --- bring your own rules -----------------------------------------------
// Pipe-delimited, one per line, because a producer can build that in a
// spreadsheet in four minutes and cannot build JSON at all. Blank lines and
// lines starting with # are ignored. Errors are reported by line number
// rather than swallowed -- a rule that silently failed to load is worse than
// no rule, because you would believe you were covered.

function parseClaims(text) {
  const claims = []; const errors = [];
  String(text || '').split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const f = line.split('|').map((x) => x.trim());
    if (f.length < 5) {
      errors.push(`Line ${i + 1}: needs 5 fields separated by | — claim | source | verifier | date | patterns. Found ${f.length}.`);
      return;
    }
    const patterns = f[4].split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
    if (!patterns.length) { errors.push(`Line ${i + 1}: no patterns listed, so this claim can never be caught.`); return; }
    claims.push({ id: `c${i}`, text: f[0], source: f[1], verifier: f[2], on: f[3], patterns });
  });
  return { claims, errors };
}

function parseOffers(text) {
  const offers = {}; const errors = [];
  String(text || '').split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const f = line.split('|').map((x) => x.trim());
    if (f.length < 6) {
      errors.push(`Line ${i + 1}: needs 6 fields — id | headline | starts | ends | regions | disclaimer. Found ${f.length}.`);
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(f[2]) || !/^\d{4}-\d{2}-\d{2}$/.test(f[3])) {
      errors.push(`Line ${i + 1}: dates must be YYYY-MM-DD. Got “${f[2]}” and “${f[3]}”.`);
      return;
    }
    if (f[3] < f[2]) errors.push(`Line ${i + 1}: this offer ends before it starts. Probably a typo, but it will never validate.`);
    offers[f[0]] = { id: f[0], headline: f[1], contract: `${f[0]} (pasted)`, locked: false,
      termStart: f[2], termEnd: f[3], regions: f[4].split(',').map((x) => x.trim()).filter(Boolean),
      eligibility: '—', killSwitch: 'green', disclaimer: f[5] };
  });
  return { offers, errors };
}

const EXAMPLE_CLAIMS = CLAIMS.map((c) => `${c.text} | ${c.source} | ${c.verifier} | ${c.on} | ${c.patterns.join(', ')}`).join('\n');
const EXAMPLE_OFFERS = Object.values(OFFERS).map((o) => `${o.id} | ${o.headline} | ${o.termStart} | ${o.termEnd} | ${o.regions.join(',')} | ${o.disclaimer}`).join('\n');

function today() { return new Date().toISOString().slice(0, 10); }

// Build an ad object out of whatever the visitor typed. Everything is optional
// except the copy; the defaults are the safe ones so a half-filled form still
// tells you something true rather than erroring.
function fromQuery(q) {
  return {
    id: 'yours', label: 'Your copy', note: 'Your own words, run against the same rules.',
    region: REGIONS.includes(q.region) ? q.region : 'US-East',
    vehicle: VEHICLES.includes(q.vehicle) ? q.vehicle : 'Meridian Nightly',
    channel: 'pasted',
    approved: /^\d{4}-\d{2}-\d{2}$/.test(q.approved) ? q.approved : today(),
    release: /^\d{4}-\d{2}-\d{2}$/.test(q.release) ? q.release : today(),
    offer: OFFERS[q.offer] ? q.offer : null,
    offerDeclared: true,
    copy: String(q.copy || '').slice(0, 2000),
    disclaimerUsed: String(q.disclaimer || '').slice(0, 2000),
    cited: []
  };
}

function fieldLabel(f, text, extra) {
  return `<label for="${f}" style="display:block;font-family:var(--mono);font-size:11.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-2);margin:${extra || '0 0 6px'}">${text}</label>`;
}
const TA = 'width:100%;background:#fff;color:var(--ink);border:1px solid var(--rule);padding:10px;font-family:var(--mono);font-size:13px;line-height:1.55;resize:vertical';
const IN = 'background:#fff;color:var(--ink);border:1px solid var(--rule);padding:8px';

function page(input) {
  const usingOwnRules = input.claimsText.trim().length > 0 || input.offersText.trim().length > 0;
  const pc = usingOwnRules ? parseClaims(input.claimsText) : { claims: CLAIMS, errors: [] };
  const po = usingOwnRules ? parseOffers(input.offersText) : { offers: OFFERS, errors: [] };
  const parseErrors = [...pc.errors, ...po.errors];

  const offersInPlay = usingOwnRules ? po.offers : OFFERS;
  const regionsInPlay = usingOwnRules
    ? [...new Set(Object.values(offersInPlay).flatMap((o) => o.regions))].filter(Boolean)
    : REGIONS;

  const custom = input.copy.trim().length > 0;
  const pick = custom
    ? { id: 'yours', label: 'Your copy', note: 'Your own words, run against the rules loaded above.',
        region: input.region || regionsInPlay[0] || 'US-East', vehicle: '—', channel: 'pasted',
        approved: input.release, release: input.release,
        offer: offersInPlay[input.offer] ? input.offer : null, offerDeclared: true,
        copy: input.copy, disclaimerUsed: input.disclaimer, cited: [] }
    : (ADS.find((a) => a.id === input.ad) || ADS[0]);

  const { gates, offer } = evaluate(pick, pc.claims, offersInPlay);
  const failed = gates.filter((g) => g.checks.some((c) => !c.ok));
  const verdict = failed.length === 0 ? 'Cleared for release' : `Held at gate ${failed[0].n}`;
  const held = failed.length > 0;

  const chooser = ADS.map((a) => (!custom && a.id === pick.id)
    ? `<strong>${esc(a.label)}</strong>`
    : `<a href="/gate?ad=${a.id}">${esc(a.label)}</a>`).join(' &nbsp;·&nbsp; ');

  const gateHtml = gates.map((g) => `
<h2><span class="num">Gate ${g.n} &middot; ${esc(g.when)}</span>${esc(g.purpose)}</h2>
${g.checks.map((c) => `<div class="band">
  <div><p style="margin:0 0 6px"><strong>${esc(c.name)}</strong></p>
  <p style="margin:0" class="note">${esc(c.detail)}</p></div>
  <div class="margin">${c.ok ? '<span class="obs">Pass</span>'
    : '<span class="obs" style="color:var(--accent);border-color:var(--accent)">Hold</span>'}</div>
</div>
<hr style="border:0;border-top:1px solid var(--rule);margin:16px 0">`).join('')}`).join('');

  return layout({
    title: 'Check content against your own rules — TheBotique',
    description: 'Load your approved claims and your live offers, paste what is about to ship, and see what holds. Runs in the browser, stores nothing, no signup and no demo booking.',
    canonical: `${SITE}/gate`,
    jsonld: { '@context': 'https://schema.org', '@type': 'WebApplication',
      name: 'Pre-publication content check', url: `${SITE}/gate`,
      applicationCategory: 'BusinessApplication',
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' } },
    body: `
<h1>Approval is a snapshot. Release is a different moment.</h1>
<p class="lede">Load your approved claims and your live offers. Paste what is about to go
out. See what holds, and why. Nothing is stored and nobody asks for your email.</p>

<p class="note" style="margin-bottom:24px"><strong>Or start from a worked example:</strong><br>${chooser}
&nbsp;·&nbsp; <a href="/gate?load=example">load the example rule set</a></p>

${parseErrors.length ? `<div class="card" style="border-color:var(--accent)">
<p style="margin:0 0 8px"><strong>${parseErrors.length} line${parseErrors.length > 1 ? 's' : ''} did not load.</strong></p>
${parseErrors.map((e) => `<p style="margin:0 0 4px" class="note">${esc(e)}</p>`).join('')}
<p style="margin:10px 0 0" class="note">Reported rather than skipped quietly. A rule that
failed to load without telling you is worse than no rule, because you would believe you
were covered.</p></div>` : ''}

<div class="card" style="border-color:var(--accent)">
<p class="obs" style="margin:0 0 10px;${held ? 'color:var(--accent);border-color:var(--accent)' : ''}">${esc(verdict)}</p>
<p style="margin:0 0 14px;font-family:var(--serif);font-size:20px;line-height:1.45">&ldquo;${esc(pick.copy)}&rdquo;</p>
<dl class="kv" style="margin:0">
<dt>Region</dt><dd>${esc(pick.region)}</dd>
<dt>Releasing</dt><dd><span class="date">${esc(pick.release)}</span></dd>
${!custom ? `<dt>Approved</dt><dd><span class="date">${esc(pick.approved)}</span></dd>` : ''}
${offer ? `<dt>Offer</dt><dd>${esc(offer.id)} &mdash; <span class="price">${esc(offer.headline)}</span>, valid ${esc(offer.termStart)} to ${esc(offer.termEnd)}</dd>` : '<dt>Offer</dt><dd>None declared &mdash; brand work</dd>'}
<dt>Rules</dt><dd>${pc.claims.length} claim${pc.claims.length === 1 ? '' : 's'}, ${Object.keys(offersInPlay).length} offer${Object.keys(offersInPlay).length === 1 ? '' : 's'} ${usingOwnRules ? '&mdash; <strong>yours</strong>' : '&mdash; the invented example set'}</dd>
</dl>
<p class="note" style="margin:14px 0 0">${esc(pick.note)}</p>
</div>

<form method="post" action="/gate">
<h2><span class="num">Your rules</span>What you are allowed to say, and until when</h2>
<p>One per line, fields separated by <code>|</code>. Blank lines and lines starting with
<code>#</code> are ignored. This is deliberately a format somebody can build in a
spreadsheet in four minutes, because the ones that need JSON never get filled in.</p>

${fieldLabel('claims', 'Approved claims &nbsp;<span style="text-transform:none;letter-spacing:0">claim | source | who verified it | date | patterns that should trip review</span>')}
<textarea id="claims" name="claims" rows="5" style="${TA}" placeholder="Ships in two business days | Fulfilment SLA, 2026 revision | Ops | 2026-06-01 | overnight, next day, same day">${esc(usingOwnRules ? input.claimsText : '')}</textarea>

${fieldLabel('offers', 'Live offers &nbsp;<span style="text-transform:none;letter-spacing:0">id | headline | starts | ends | regions | the exact disclaimer that must run with it</span>', '18px 0 6px')}
<textarea id="offers" name="offers" rows="4" style="${TA}" placeholder="SPRING | 20% off | 2026-03-01 | 2026-03-31 | US-East,US-West | 20% off first order. New customers only. Ends 3/31/2026.">${esc(usingOwnRules ? input.offersText : '')}</textarea>

<h2><span class="num">Your copy</span>What is about to go out</h2>
${fieldLabel('copy', 'The words')}
<textarea id="copy" name="copy" rows="3" style="${TA};font-family:var(--sans);font-size:16px" placeholder="Paste a script, a headline, a subject line, a social caption&hellip;">${esc(input.copy)}</textarea>

${fieldLabel('disclaimer', 'Disclaimer as it will actually run &nbsp;<span style="text-transform:none;letter-spacing:0">leave blank if there is not one</span>', '18px 0 6px')}
<textarea id="disclaimer" name="disclaimer" rows="2" style="${TA};font-family:var(--sans);font-size:15px">${esc(input.disclaimer)}</textarea>

<div style="display:flex;flex-wrap:wrap;gap:18px;margin-top:16px">
<div>${fieldLabel('region', 'Region')}<select id="region" name="region" style="${IN}">
${regionsInPlay.map((r) => `<option value="${esc(r)}"${pick.region === r ? ' selected' : ''}>${esc(r)}</option>`).join('')}
</select></div>
<div>${fieldLabel('offer', 'Offer')}<select id="offer" name="offer" style="${IN}">
<option value=""${!pick.offer ? ' selected' : ''}>None &mdash; brand work</option>
${Object.values(offersInPlay).map((o) => `<option value="${esc(o.id)}"${pick.offer === o.id ? ' selected' : ''}>${esc(o.id)} (ends ${esc(o.termEnd)})</option>`).join('')}
</select></div>
<div>${fieldLabel('release', 'Release date')}<input id="release" name="release" type="date" value="${esc(input.release)}" style="${IN};font-family:var(--sans)"></div>
</div>
<p style="margin:18px 0 0"><button type="submit" class="cta">Run the gates</button></p>
<p class="note" style="margin:10px 0 0">Posted, evaluated, and discarded. Nothing is written
to a database and there is no account. That also means the result is not a link you can
send &mdash; if you need to share it, screenshot it.</p>
</form>

${gateHtml}

<h2><span class="num">Why gate 03</span>The failure nobody designs for</h2>
<p>Nobody ships something they know is wrong. What actually happens is duller: it gets
reviewed properly, approved properly, and then sits in a queue while the thing it advertises
expires underneath it. The words never changed. The offer did.</p>
<div class="pull">Approval is a snapshot. Release is a different moment, and the only one
that matters.</div>
<p>So the third gate does not trust the second one. It re-reads the offer at the moment of
release and asks whether it is still true today. Of the pre-publication compliance tools
whose feature lists are public &mdash; Red Marker, PerformLine, Sedric, Blee, Haast,
Luthor, ComplyAuto Guardian &mdash; none describes doing this.</p>

<h2><span class="num">Honestly</span>What this does not do</h2>
<p>It is not legal advice and not a compliance certification. It checks whether your copy
says something your own list says needs substantiating, whether the disclaimer matches the
text you told it to expect, and whether the dates still line up. Deciding what your rules
<em>are</em> is a lawyer&rsquo;s job. Running them three hundred times a month is not.</p>
<p class="note">Every example here is invented. A page demonstrating how review works should
never be somewhere a real approved-claims list ends up published.</p>

<p><a class="cta" href="mailto:hello@thebotique.ai?subject=The%20gate">hello@thebotique.ai</a></p>`
  });
}

function readInput(src) {
  return {
    ad: typeof src.ad === 'string' ? src.ad : '',
    copy: String(src.copy || '').slice(0, 4000),
    disclaimer: String(src.disclaimer || '').slice(0, 4000),
    claimsText: String(src.claims || '').slice(0, 20000),
    offersText: String(src.offers || '').slice(0, 20000),
    region: String(src.region || ''),
    offer: String(src.offer || ''),
    release: /^\d{4}-\d{2}-\d{2}$/.test(src.release) ? src.release : today()
  };
}

function mount(router) {
  router.get('/gate', (req, res) => {
    const input = readInput(req.query);
    if (req.query.load === 'example') {
      input.claimsText = EXAMPLE_CLAIMS;
      input.offersText = EXAMPLE_OFFERS;
    }
    res.send(page(input));
  });
  router.post('/gate', (req, res) => res.send(page(readInput(req.body || {}))));
  return router;
}

module.exports = { mount, CLAIMS, OFFERS, ADS, evaluate, parseClaims, parseOffers };
