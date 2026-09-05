'use strict';
// evaluateCheckpoint's verdict, pinned against fixtures rather than a live log.
//
// Before this fix, `check()` FAILed whenever the checkpoint's `size` did not
// exactly equal the number of posts served -- which is chronic on any log that
// accepts writes between checkpoints, i.e. every live log there is. Worse, the
// baseline was only persisted `if (verdict === 'ok')`, so a log that could
// never pass also never accumulated the memory this witness exists to keep --
// its actual job (catching rollback, rewrite, equivocation across runs) never
// engaged. A checkpoint commits to its first `size` leaves, not to the log
// having no more than `size` leaves; growth past that is expected, and only
// the PREFIX is what must reproduce the signed root.
//
// These tests use the real leafHash/merkleRoot/verifyNote from witness.js --
// no fetch, no fs, no live log.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const crypto = require('crypto');
const W = require('./witness');

function genKeypair() {
  return crypto.generateKeyPairSync('ed25519');
}

function pubRaw(publicKey) {
  return publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('base64url');
}

// The same transparency-dev signed-note wire format store.js's
// noteBody/serialiseCheckpoint produce: origin, size, base64 root, a blank
// line, then "— origin key_id signature". Built by hand rather than imported
// -- an independent construction is the entire point of this file.
function makeNote({ origin = 'sigil.thebotique.ai', size, rootHex, privateKey }) {
  const body = `${origin}\n${size}\n${Buffer.from(rootHex, 'hex').toString('base64')}\n`;
  const signature = crypto.sign(null, Buffer.from(body, 'utf8'), privateKey).toString('base64');
  return `${body}\n— ${origin} k1 ${signature}\n`;
}

function post(i, body) {
  return { id: i, handle: 'agent', body, parent: null, ts: `2026-01-0${i}T00:00:00Z` };
}

test('evaluateCheckpoint: a grown log -- checkpoint covers a prefix, more posts served since -- is OK and would persist a new baseline', () => {
  const { publicKey, privateKey } = genKeypair();
  const pub = pubRaw(publicKey);
  const posts = [1, 2, 3, 4, 5].map((i) => post(i, `post ${i}`));
  const prefixRoot = W.merkleRoot(posts.slice(0, 3).map(W.leafHash));
  const note = makeNote({ size: 3, rootHex: prefixRoot, privateKey });
  const sig = W.verifyNote(note, pub);
  assert.strictEqual(sig.ok, true, 'test setup: the checkpoint signature must itself verify');

  const r = W.evaluateCheckpoint({ sig, size: 3, root: prefixRoot, posts, prev: null });
  // check() persists the baseline exactly `if (verdict === 'ok')` -- this is
  // the case that used to be impossible on a live log (5 served !== 3
  // claimed), so 'ok' here is what proves the persistence gate now opens.
  assert.strictEqual(r.verdict, 'ok', `expected ok, got FAIL: ${JSON.stringify(r.findings)}`);
  assert.strictEqual(r.prefix_root, prefixRoot);
  assert.ok(r.findings.some((f) => /grown/i.test(f)), 'growth should be noted, even though it is not a failure');
});

test('evaluateCheckpoint: altering a post inside the checkpointed prefix is a FAIL, even on a log that has since grown', () => {
  const { publicKey, privateKey } = genKeypair();
  const pub = pubRaw(publicKey);
  const original = [1, 2, 3].map((i) => post(i, `post ${i}`));
  const honestRoot = W.merkleRoot(original.map(W.leafHash));
  const note = makeNote({ size: 3, rootHex: honestRoot, privateKey });
  const sig = W.verifyNote(note, pub);
  assert.strictEqual(sig.ok, true, 'test setup: the checkpoint signature must itself verify');

  // The log now serves 5 posts (ordinary growth), but post #2 -- inside the
  // prefix this checkpoint committed to -- no longer reads the way it did
  // when the checkpoint was signed. Growth must not hide this.
  const tampered = [post(1, 'post 1'), post(2, 'EDITED AFTER THE CHECKPOINT'), post(3, 'post 3'),
    post(4, 'post 4'), post(5, 'post 5')];

  const r = W.evaluateCheckpoint({ sig, size: 3, root: honestRoot, posts: tampered, prev: null });
  assert.strictEqual(r.verdict, 'FAIL');
  assert.ok(r.findings.some((f) => /does not match/.test(f)));
});

test('evaluateCheckpoint: a checkpoint claiming a smaller tree_size than the persisted baseline is a FAIL (rollback)', () => {
  const { publicKey, privateKey } = genKeypair();
  const pub = pubRaw(publicKey);
  const posts = [1, 2, 3].map((i) => post(i, `post ${i}`));
  const root = W.merkleRoot(posts.map(W.leafHash));
  const note = makeNote({ size: 3, rootHex: root, privateKey });
  const sig = W.verifyNote(note, pub);
  assert.strictEqual(sig.ok, true, 'test setup: the checkpoint signature must itself verify');

  // A baseline from an earlier, bigger run. prev.tree_size (5) > this
  // checkpoint's size (3) is exactly a shrinking tree -- no innocent
  // explanation for one.
  const prev = { tree_size: 5, root: 'f'.repeat(64), at: '2026-01-01T00:00:00Z' };
  const r = W.evaluateCheckpoint({ sig, size: 3, root, posts, prev });
  assert.strictEqual(r.verdict, 'FAIL');
  assert.ok(r.findings.some((f) => /ROLLBACK/.test(f)));
});

test('evaluateCheckpoint: the previously-witnessed prefix reproducing a different root is a FAIL (history rewrite)', () => {
  const { publicKey, privateKey } = genKeypair();
  const pub = pubRaw(publicKey);
  const originalFirstThree = [1, 2, 3].map((i) => post(i, `post ${i}`));
  const witnessedRoot = W.merkleRoot(originalFirstThree.map(W.leafHash));
  const prev = { tree_size: 3, root: witnessedRoot, at: '2026-01-01T00:00:00Z' };

  // The log has grown to 5 and is internally self-consistent right now -- its
  // new checkpoint's root really is produced by these 5 posts (prefixRoot ==
  // root, size == posts.length). But post #2 differs from what was witnessed
  // at tree_size 3: the first 3 entries no longer reproduce the earlier root.
  const rewritten = [post(1, 'post 1'), post(2, 'REWRITTEN'), post(3, 'post 3'),
    post(4, 'post 4'), post(5, 'post 5')];
  const newRoot = W.merkleRoot(rewritten.map(W.leafHash));
  const note = makeNote({ size: 5, rootHex: newRoot, privateKey });
  const sig = W.verifyNote(note, pub);
  assert.strictEqual(sig.ok, true, 'test setup: the checkpoint signature must itself verify');

  const r = W.evaluateCheckpoint({ sig, size: 5, root: newRoot, posts: rewritten, prev });
  assert.strictEqual(r.verdict, 'FAIL');
  assert.ok(r.findings.some((f) => /HISTORY REWRITTEN/.test(f)));
});
