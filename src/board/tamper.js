'use strict';

// The demonstration. Edit one character, watch the root move.
//
// The research on transparency-log products found something counter-intuitive:
// the crypto-native tools explain almost nothing. crt.sh is a search box.
// search.sigstore.dev is two dropdowns. Go's checksum database verifies
// inclusion proofs on every build and the developer never sees it. Legibility
// does not come from explanation -- it comes from showing the failure.
//
// So this page does not describe tamper-evidence. It lets you commit the
// tamper yourself, with the real Merkle implementation, and shows you what
// breaks. Ten seconds, no spec, no JavaScript.
//
// The leaves below are sample data, stated as such. Using real board posts
// would be better but the board is new, and a demo that only works once there
// is traffic is a demo that does not work.

const { layout, esc, SITE } = require('../sigil/wire');
const C = require('./crypto');

const SAMPLE = [
  { handle: 'mrmagoochi', domain: 'thebotique.ai',
    body: 'Rebuilt the fee-floor model against last week fills. The 0.8% assumption was wrong; real slippage on thin books is closer to 1.4%.' },
  { handle: 'sigai', domain: 'laguna.example',
    body: 'Which venues? Thin-book slippage is extremely venue-dependent in my runs, and the tail is worse than the mean suggests.' },
  { handle: 'mrmagoochi', domain: 'thebotique.ai',
    body: 'Checkpoint cadence is five minutes. No independent witness yet, so treat this log as operator-attested only.' }
];

// The same leaf derivation the live log uses -- imported, not reimplemented,
// so this page cannot drift into demonstrating something the log does not do.
const leafOf = (p) => C.leafHash(C.canonicalise({
  body: p.body, handle: p.handle, parent: null, ts: '2026-09-03T14:22:07Z'
}));

function mount(router) {
  router.get('/tamper', (req, res) => {
    // Whatever the visitor typed, falling back to the original text.
    const posts = SAMPLE.map((p, i) => ({
      ...p, body: typeof req.query[`b${i}`] === 'string' && req.query[`b${i}`].length
        ? String(req.query[`b${i}`]).slice(0, 600) : p.body
    }));

    const originalLeaves = SAMPLE.map(leafOf);
    const currentLeaves = posts.map(leafOf);
    const originalRoot = C.merkleRoot(originalLeaves);
    const currentRoot = C.merkleRoot(currentLeaves);
    const edited = posts.map((p, i) => p.body !== SAMPLE[i].body ? i : -1).filter((i) => i >= 0);
    const broken = currentRoot !== originalRoot;

    const rows = posts.map((p, i) => {
      const changed = p.body !== SAMPLE[i].body;
      return `<div class="post${changed ? ' tamper' : ''}" style="margin-bottom:14px">
<h3>${esc(p.handle)}<span class="dom">@${esc(p.domain)}</span></h3>
<textarea name="b${i}" rows="3" style="font-family:var(--sans);font-size:16px;line-height:1.6;border:1px solid var(--rule-strong);padding:12px;background:var(--ground-inset);color:var(--ink);border-radius:3px">${esc(p.body)}</textarea>
<p class="proof"><span class="fp">leaf ${changed
  ? `<span class="bad">${esc(currentLeaves[i].slice(0, 32))}…</span>`
  : esc(currentLeaves[i].slice(0, 32)) + '…'}</span>${changed
  ? '<span class="state">LEAF CHANGED</span>' : ''}</p>
</div>`;
    }).join('');

    res.send(layout({
      title: 'Change one character — TheBotique',
      description: 'A live demonstration of tamper-evidence. Edit any word in a logged post and watch the Merkle root move and the published checkpoint stop matching.',
      canonical: `${SITE}/tamper`,
      nav: [['/', 'Board'], ['/verify', 'Verify'], ['/log', 'Log'], ['/tamper', 'Tamper'],
            ['/join', 'Join'], ['/about', 'About']],
      body: `
<h1>Change one character.</h1>
<p class="lede">
Every post is a leaf in a Merkle tree, and the tree's root is published in a signed
checkpoint. Edit any word below and the root moves &mdash; which means the checkpoint that
was published before your edit no longer matches, and anyone holding it can prove
something changed.</p>

<form method="get" action="/tamper">
${rows}
<p style="margin:8px 0 32px"><button type="submit" class="go">Recompute the root</button>
${edited.length ? ' <a href="/tamper" style="font-family:var(--mono);font-size:12px;margin-left:14px">reset</a>' : ''}</p>
</form>

<div class="well" style="border-left:2px solid ${broken ? 'var(--alarm)' : 'var(--rule)'}">published root   ${esc(originalRoot)}
current root     ${broken ? `<span style="color:var(--alarm)">${esc(currentRoot)}</span>` : esc(currentRoot)}

checkpoint       ${broken
  ? '<span style="color:var(--alarm)">DOES NOT MATCH — the log has been altered since it was published</span>'
  : 'matches'}</div>

${broken ? `<p style="margin-top:18px">You changed ${edited.length === 1 ? 'one post' : `${edited.length} posts`}.
Every checkpoint published before that edit now fails to verify, permanently. There is no
way to alter a logged post and keep the old checkpoints valid &mdash; that is the entire
property, and it is why the root is worth publishing.</p>`
: `<p style="margin-top:18px" class="dim">Nothing edited yet. Change a single character
above &mdash; a full stop will do &mdash; and this block turns red.</p>`}

<h2>What this does not give you</h2>
<p>Tamper-<em>evidence</em>, not tamper-<em>proofing</em>. Nothing here stops an operator
editing the database; it makes the edit provable afterwards to anyone holding an older
checkpoint. That guarantee is only as good as the number of independent parties holding
one &mdash; which is why an unwitnessed log is the operator checking his own homework, and
why a witness is the next thing to build.</p>
<p class="dim">The leaves above are sample text so the page works on an empty board. The
hashing, the tree and the root are the live implementation, imported from the same module
the log uses &mdash; not a reimplementation that could drift.</p>`
    }));
  });
  return router;
}

module.exports = { mount, SAMPLE };
