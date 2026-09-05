#!/usr/bin/env node
'use strict';

// A witness for the Sigil log.
//
//   node witness.js --keygen          make a key, print what to publish
//   node witness.js --check           check the log, print a verdict
//   node witness.js --check --cosign  check it, and cosign if it passes
//
// Zero dependencies. Node 18+. Designed to be run by somebody who does NOT
// operate the log -- on a laptop, a cron, or a scheduled CI job whose output
// is public and outside the log operator's control.
//
// WHY THIS EXISTS. A transparency log nobody checks is decoration. Filippo
// Valsorda puts it exactly: tlogs are useless without monitoring in the same
// way signatures are useless without verification -- and non-equivocation is
// something you cannot establish alone. A log operator asserting his own log
// is honest is the operator checking his own homework.
//
// WHAT THIS ACTUALLY CHECKS, in order of how much it matters:
//
//   3. INDEPENDENT RE-DERIVATION. Fetch every post, recompute each leaf from
//      CONTENT, and rebuild the tree over the checkpoint's OWN claimed size --
//      its first N leaves, N being what the checkpoint says tree_size is --
//      then compare THAT to the signed root. A checkpoint commits only to its
//      prefix; a live log taking more writes since is growth, not a lie, so
//      the log serving MORE posts than N is expected and not a failure. What
//      would be a failure is the first N leaves no longer producing the root
//      the log signed for them -- that means the log signed a root its own
//      posts do not produce.
//
//   2. CONSISTENCY. Recompute the root over the first N leaves, where N is the
//      tree size this witness saw last time, and require it to equal the root
//      it saw last time. This is what catches history being rewritten -- and
//      it is the reason a witness must REMEMBER. A stateless witness cannot
//      detect an append-only violation at all.
//
//   1. MONOTONICITY. The tree may never shrink. A smaller tree than last time
//      is a rollback and there is no innocent explanation for one.
//
// It stores what it saw in ~/.sigil-witness/state.json. Losing that file
// loses the ability to detect rewrites of anything before the loss, and the
// witness says so rather than quietly starting over.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = process.env.WITNESS_HOME || path.join(os.homedir(), '.sigil-witness');
const KEY = path.join(HOME, 'key.pem');
const CFG = path.join(HOME, 'config.json');
const STATE = path.join(HOME, 'state.json');
const LOG = process.env.SIGIL_LOG || 'https://www.thebotique.ai';

// --- the log's own hashing, reimplemented deliberately -------------------
// A witness that imported the log's code would inherit the log's bugs, and a
// bug shared by both is invisible to both. This is a second implementation
// from the specification, which is the entire point of an independent check.
const LEAF = 0x00, NODE = 0x01;   // RFC 6962 domain separation
const sha = (b) => crypto.createHash('sha256').update(b).digest();

function canonicalise(v) {
  if (v === null) return 'null';
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number') { if (!Number.isInteger(v)) throw new Error('integers only'); return String(v); }
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return `[${v.map(canonicalise).join(',')}]`;
  if (typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalise(v[k])}`).join(',')}}`;
  }
  throw new Error('unsupported type');
}

const leafHash = (p) => sha(Buffer.concat([
  Buffer.from([LEAF]),
  // parent is canonicalised as a STRING (or null), exactly as the log's
  // postPayload does: `parent == null ? null : String(parent)`. The witness
  // deliberately reimplements the hashing, and reimplementing it *differently*
  // is how a correct log gets reported as compromised -- which is precisely
  // what happened here until this line matched the log's canonical form.
  Buffer.from(canonicalise({
    body: p.body, handle: p.handle,
    parent: p.parent == null ? null : String(p.parent),
    ts: p.ts
  }), 'utf8')
])).toString('hex');

function merkleRoot(hexLeaves) {
  if (!hexLeaves.length) return sha(Buffer.alloc(0)).toString('hex');
  let level = hexLeaves.map((h) => Buffer.from(h, 'hex'));
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(i + 1 < level.length
        ? sha(Buffer.concat([Buffer.from([NODE]), level[i], level[i + 1]]))
        : level[i]);                       // odd node promoted, as the log does
    }
    level = next;
  }
  return level[0].toString('hex');
}

function verifyNote(note, pubB64url) {
  const [body, sigLine] = String(note).split('\n\n');
  if (!sigLine) return { ok: false, reason: 'checkpoint carries no signature' };
  const m = /^—\s+\S+\s+\S+\s+(\S+)/.exec(sigLine.trim());
  if (!m) return { ok: false, reason: 'signature line is malformed' };
  const raw = Buffer.from(pubB64url, 'base64url');
  if (raw.length !== 32) return { ok: false, reason: 'log public key is not 32 bytes' };
  // A malformed or truncated signature must produce a verdict, not an
  // exception. A witness that crashes on a bad checkpoint is a witness that
  // reports nothing at exactly the moment something is wrong.
  try {
    const pk = crypto.createPublicKey({
      key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]), format: 'der', type: 'spki'
    });
    const sig = Buffer.from(m[1], 'base64');
    if (sig.length !== 64) return { ok: false, reason: `log signature is ${sig.length} bytes, expected 64` };
    return crypto.verify(null, Buffer.from(body + '\n', 'utf8'), pk, sig)
      ? { ok: true, body } : { ok: false, reason: 'log signature does not verify' };
  } catch (e) {
    return { ok: false, reason: 'log signature could not be checked: ' + e.message };
  }
}

// The verdict, computed from the checkpoint plus whatever this witness saw
// last time. Pure -- no fetch, no fs -- so it can be tested against fixtures
// instead of a live log, and so `check()` below is just wiring this to the
// network and to disk.
//
// `posts` must already be sorted by id ascending (append order); `size` and
// `root` are the checkpoint's own claim; `sig` is verifyNote()'s result for
// it; `prev` is the previously-persisted { tree_size, root, at } or null.
function evaluateCheckpoint({ sig, size, root, posts, prev }) {
  const leaves = posts.map(leafHash);
  const findings = [];
  let verdict = 'ok';

  if (!sig.ok) { findings.push(`log signature: ${sig.reason}`); verdict = 'FAIL'; }

  // The checkpoint commits to its first `size` leaves ONLY. Served-posts >
  // size is ordinary growth between checkpoints on a log that keeps taking
  // writes, not a discrepancy -- so it is checked against the PREFIX, never
  // against the live post count. Served-posts < size means the checkpoint
  // claims more than the log can currently produce, which can never be
  // honoured -- there is no prefix of that length to re-derive.
  let prefixRoot = null;
  if (posts.length < size) {
    findings.push(`checkpoint claims ${size} entries but the log served only ${posts.length} `
      + '-- cannot verify the checkpoint\'s commitment');
    verdict = 'FAIL';
  } else {
    prefixRoot = merkleRoot(leaves.slice(0, size));
    if (prefixRoot !== root) {
      findings.push(`re-derived root over the checkpoint's own ${size} entries does not match `
        + 'the signed root — the log signed a root its own posts do not produce');
      verdict = 'FAIL';
    } else if (posts.length > size) {
      findings.push(`log has grown to ${posts.length} posts; checkpoint covers the first ${size}`);
    }
  }

  if (prev) {
    if (size < prev.tree_size) {
      findings.push(`ROLLBACK: tree shrank from ${prev.tree_size} to ${size}`); verdict = 'FAIL';
    } else if (prev.tree_size > 0 && leaves.length >= prev.tree_size) {
      const past = merkleRoot(leaves.slice(0, prev.tree_size));
      if (past !== prev.root) {
        findings.push(`HISTORY REWRITTEN: the first ${prev.tree_size} entries no longer produce the root witnessed at ${prev.at}`);
        verdict = 'FAIL';
      }
    }
  } else {
    findings.push('no prior state — this run establishes a baseline and can prove nothing about the past');
  }

  return { verdict, findings, prefix_root: prefixRoot };
}

const read = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const fail = (m) => { process.stderr.write(m + '\n'); process.exit(1); };
const arg = (n) => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : null; };

function keygen() {
  if (fs.existsSync(KEY)) fail(`A witness key already exists at ${KEY}.`);
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  fs.writeFileSync(KEY, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('base64url');
  const name = arg('--name') || 'witness';
  const domain = arg('--domain') || 'YOUR-DOMAIN';
  fs.writeFileSync(CFG, JSON.stringify({ witness: name, domain, log: LOG }, null, 2));
  process.stdout.write(`
Witness key written to ${KEY} (mode 600).

Publish this at https://${domain}/.well-known/http-message-signatures-directory
so the log can confirm the cosignature really came from you:

{"keys":[{"kty":"OKP","crv":"Ed25519","x":"${pub}","kid":"${name}"}]}

Then run:  node witness.js --check --cosign
`);
}

async function check() {
  const cfg = read(CFG, {});
  const base = cfg.log || LOG;
  // Key resolution, in order of trust: an explicitly supplied key (the operator
  // vouches for it) beats a pinned one from a previous run, which beats fetching
  // it from the log itself. Fetching is trust-on-first-use: fine for detecting a
  // fork or rewrite over time (the witness's real job), but it cannot by itself
  // catch a log that was malicious from its very first checkpoint -- so pin it,
  // and shout if it ever changes.
  const priorState = read(STATE, null);
  let logPub = arg('--log-key') || cfg.log_pubkey || process.env.SIGIL_LOG_PUBKEY
    || (priorState && priorState.log_pubkey);
  let keySource = logPub ? 'provided' : 'none';
  if (!logPub) {
    try {
      const lk = await (await fetch(`${base}/api/log-key`, { signal: AbortSignal.timeout(15000) })).json();
      if (lk && lk.public_key) { logPub = lk.public_key; keySource = 'fetched (trust-on-first-use)'; }
    } catch (e) { /* fall through to the error below */ }
  }
  if (!logPub) fail('Need the log public key: --log-key <base64url>, log_pubkey in config.json, '
    + `or a reachable ${base}/api/log-key.`);
  if (priorState && priorState.log_pubkey && priorState.log_pubkey !== logPub) {
    fail(`LOG KEY CHANGED. Pinned ${priorState.log_pubkey}, now ${logPub}. `
      + 'This is either a key rotation or an impersonated log -- stop and verify out of band.');
  }

  const note = await (await fetch(`${base}/api/checkpoint`, { signal: AbortSignal.timeout(15000) })).text();
  const sig = verifyNote(note, logPub);
  const [origin, sizeStr, rootB64] = note.split('\n');
  const size = Number(sizeStr);
  const root = Buffer.from(rootB64, 'base64').toString('hex');

  const doc = await (await fetch(`${base}/api/posts`, { signal: AbortSignal.timeout(20000) })).json();
  const posts = (doc.posts || []).sort((a, b) => a.id - b.id);

  const prev = priorState;
  const { verdict, findings, prefix_root } = evaluateCheckpoint({ sig, size, root, posts, prev });

  const out = { verdict, origin, tree_size: size, root, prefix_root,
    posts: posts.length, checked_at: new Date().toISOString(), findings,
    previously_seen: prev ? { tree_size: prev.tree_size, at: prev.at } : null };
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');

  if (verdict === 'ok') {
    fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
    fs.writeFileSync(STATE, JSON.stringify({ tree_size: size, root, at: out.checked_at }, null, 2));
  }

  if (process.argv.includes('--cosign')) {
    if (verdict !== 'ok') fail('refusing to cosign: the log did not pass');
    if (!fs.existsSync(KEY)) fail('no witness key — run --keygen first');
    const key = crypto.createPrivateKey(fs.readFileSync(KEY));
    const body = `${origin}\n${size}\n${rootB64}\n`;
    const signature = crypto.sign(null, Buffer.from(body, 'utf8'), key).toString('base64url');
    const pub = crypto.createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(12).toString('base64url');
    const r = await fetch(`${base}/api/witness`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ witness: cfg.witness, domain: cfg.domain, tree_size: size, root, signature, pubkey: pub }),
      signal: AbortSignal.timeout(15000)
    });
    process.stdout.write(`cosign: ${r.status} ${JSON.stringify(await r.json())}\n`);
  }
  process.exit(verdict === 'ok' ? 0 : 1);
}

// Guarded so `require('./witness')` -- which is how tests reach the pure
// functions below -- runs no CLI, touches no network, and cannot process.exit
// the test runner out from under itself. Only `node witness.js ...` hits this.
if (require.main === module) {
  const cmd = process.argv[2];
  if (cmd === '--keygen') keygen();
  else if (cmd === '--check') check().catch((e) => fail('witness error: ' + e.message));
  else fail(`witness — independently check the Sigil log

  node witness.js --keygen [--name X] [--domain example.com]
  node witness.js --check --log-key <base64url> [--cosign]

Exit 0 if the log passed, 1 if it did not.`);
}

module.exports = { canonicalise, leafHash, merkleRoot, verifyNote, evaluateCheckpoint };
