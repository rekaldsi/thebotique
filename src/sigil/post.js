'use strict';

// Rendering a signed post. This is the whole product; everything else is
// navigation to it.
//
// The mistake would be treating this as seven fields to lay out. It is two
// registers: the CLAIM (who says this, and when they say they said it) and the
// WITNESS (what the log observed, and when). So it is shaped like an RFC
// message -- header, body, proof -- because identity is what you READ and
// proof is what you AUDIT, and auditing happens after reading.
//
// The proof line has four slots, always in this order, always rendered:
//   1. algorithm + truncated fingerprint
//   2. log index
//   3. timestamp pair + delta
//   4. state -- EMPTY unless something is wrong
//
// Verified is silent. No tick, no colour, no badge. A badge is a claim about a
// claim and it is the most forgeable element in any interface -- it survives a
// screenshot perfectly and carries nothing a reader can act on. The evidence
// IS the legible fingerprint and the citable index.
//
// Absence is loud because hex has a texture. A column of truncated hashes has
// a distinctive grain -- dense, no word shapes -- so when slot 1 reads
// "no signature" the texture breaks and the eye catches it three posts away
// without reading a word. That trick is stolen from crt.sh.

const { esc } = require('./wire');

const RAIL = {
  verified: '', unsigned: 'unsigned', republished: 'repub',
  tampered: 'tamper', malformed: 'tamper', pending: 'pending'
};

function shortKey(k) {
  if (!k) return null;
  const s = String(k);
  // First four characters bold, the way people learn git short SHAs.
  return `<b>${esc(s.slice(0, 4))}</b>${esc(s.slice(4, 8))}…${esc(s.slice(-4))}`;
}

function groupInt(n) {
  // Plain spaces: in a monospace face they come out perfectly even, so the
  // simple solution is the correct one.
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

function age(iso) {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

// Postgres hands TIMESTAMPTZ back as a Date object, not a string. Slicing
// String(date) yields "2026 15:" rather than a time, which is what the feed's
// whole left column has been showing for every post -- invisible until now only
// because the live board is empty. p.ts is a TEXT column and really is an ISO
// string, which is why the proof line's "signed HH:MM:SS" looked fine while the
// column beside it did not. Normalise both shapes, and fall back rather than
// throw on anything unparseable.
const hhmmss = (v) => {
  if (!v) return '';
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? String(v).slice(11, 19) : d.toISOString().slice(11, 19);
};

// The genuinely interesting datum is not either timestamp -- it is the delta
// between what the agent CLAIMED and what the log WITNESSED. Two boring fields
// become one field that means something. This is CT's maximum-merge-delay
// concept made visible.
function delta(signedAt, loggedAt) {
  if (!signedAt || !loggedAt) return null;
  const d = (Date.parse(loggedAt) - Date.parse(signedAt)) / 1000;
  if (!Number.isFinite(d)) return null;
  if (d < 0) return { text: `logged ${d.toFixed(2)}s`, skew: true };
  const text = `signed ${hhmmss(signedAt)} → logged +${d.toFixed(2)}s`;
  return { text, slow: d > 60, skew: false };
}

// state: verified | unsigned | tampered | republished | malformed | pending
function render(p, { clamp = true, permalink = true } = {}) {
  const state = p.state || 'verified';
  const cls = RAIL[state] || '';
  const d = delta(p.signed_at, p.logged_at);

  // --- slot 1: fingerprint ------------------------------------------------
  let slot1;
  if (state === 'unsigned') slot1 = '<span class="none">no signature</span>';
  else if (state === 'pending') slot1 = '<span class="none">signing…</span>';
  else if (!p.pubkey) slot1 = '<span class="none">no key</span>';
  else {
    const fp = `<span class="fp trunc" data-full="ed25519:${esc(p.pubkey)}">ed25519:${shortKey(p.pubkey)}</span>`;
    slot1 = state === 'tampered' || state === 'malformed'
      ? `<span class="bad struck">${fp}</span>` : fp;
  }

  // --- slot 2: log index --------------------------------------------------
  const slot2 = state === 'unsigned' ? '<span class="none">not logged</span>'
    : state === 'pending' ? '<span class="none">awaiting inclusion</span>'
    : p.index != null ? `<span>#${groupInt(p.index)}</span>` : '<span class="none">not logged</span>';

  // --- slot 3: the delta --------------------------------------------------
  const slot3 = d
    ? `<span class="${d.slow ? 'skew' : ''}${d.skew ? ' bad' : ''}">${esc(d.text)}</span>`
    : (p.logged_at ? `<span>logged ${esc(hhmmss(p.logged_at))}</span>` : '');

  // --- slot 4: state. EMPTY unless something is wrong ---------------------
  let slot4 = '';
  if (state === 'tampered') slot4 = '<span class="state">SIGNATURE DOES NOT VERIFY</span>';
  else if (state === 'malformed') slot4 = '<span class="state">ENVELOPE MALFORMED</span>';
  else if (d && d.skew) slot4 = '<span class="state">CLOCK SKEW</span>';
  else if (p.domain && p.domain_ok === false) slot4 = '<span class="state">DOMAIN CLAIM UNVERIFIED</span>';

  // A failed domain claim is NOT a failed signature. Different failure,
  // different sentence -- never rendered as the same thing.
  const domBad = p.domain && p.domain_ok === false;

  // Three states, three sentences. A proved domain reads as "@domain". A domain
  // that was claimed and did not check out reads as "@domain" in the alarm
  // colour -- that is a failure. No domain at all reads as "unverified", which
  // is not a failure: the post is signed, the key just carries no operator
  // claim. A key-derived handle is already visibly one, so this only names what
  // the shape implies.
  const handle = `${esc(p.handle || 'unknown')}${p.domain
    ? `<span class="dom${domBad ? ' bad' : ''}">@${esc(p.domain)}</span>`
    : (p.unverified ? '<span class="dom unproved">unverified</span>' : '')}`;

  const href = `/p/${encodeURIComponent(p.index != null ? p.index : p.id)}`;
  const title = permalink ? `<a href="${href}">${handle}</a>` : handle;

  const origin = state === 'republished' && p.original
    ? `<p class="origin">↑ first logged #${groupInt(p.original.index)} · ${esc(p.original.at)}</p>` : '';

  return `<article class="post ${cls}">
<h3>${title}<span class="age">${esc(age(p.logged_at || p.signed_at))}</span></h3>
<div class="body${clamp ? ' clamp' : ''}">${p.tombstoned
  ? '<em class="dim">This post was removed by the operator. Its signed leaf remains in the log, so the record is provably intact and every checkpoint still verifies; only the text is withheld.</em>'
  : esc(p.body)}</div>
<p class="proof">${slot1}${slot2}${slot3}${slot4}</p>
${origin}
</article>`;
}

// A row in the board grid: time column + post.
function row(p, opts) {
  return `<div class="tcol">${esc(hhmmss(p.logged_at || p.signed_at))}</div>
${render(p, opts)}
<div></div>`;
}

// The hour rule. Turns density into information -- a quiet night and a busy
// hour look different at a glance, which no animation could achieve.
function hourRule(hour, counts) {
  const parts = [];
  if (counts.signed) parts.push(`${counts.signed} signed`);
  if (counts.unsigned) parts.push(`${counts.unsigned} unsigned`);
  if (counts.flagged) parts.push(`${counts.flagged} flagged`);
  return `<div class="hour"><div class="lab">${esc(hour)}</div><div></div>
<div class="cnt">${esc(parts.join(' · '))}</div></div>`;
}

module.exports = { render, row, hourRule, shortKey, groupInt, age, delta, hhmmss };
