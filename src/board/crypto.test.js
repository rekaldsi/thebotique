'use strict';

// Pure signature, canonicalisation and Merkle-tree coverage for crypto.js.
// Deliberately DB-free -- everything here is a function of its arguments, so
// none of it needs Postgres or a fake stand-in for it.
//
// The parent-stringification test below pins a real incident: the log
// canonicalised `parent` as a string and the witness (src/witness/witness.js)
// didn't, so a post whose parent id round-tripped through Postgres as a
// string (BIGINT columns come back from node-pg as strings, not numbers)
// hashed differently than the same post verified at ingest, where parent is
// still a freshly-parsed JS number. A correct log got reported as compromised
// by its own witness. See src/witness/canonical.test.js, which pins the
// witness side of the same fix; this file pins the log side.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const crypto = require('crypto');
const C = require('./crypto');

function genKeypair() {
  return crypto.generateKeyPairSync('ed25519');
}

// The same 12-byte-prefix slice crypto.js and store.js use everywhere they
// need the raw 32-byte public key out of a KeyObject.
function rawPubKeyB64url(publicKey) {
  return publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('base64url');
}

function sign(privateKey, payloadString) {
  return crypto.sign(null, Buffer.from(payloadString, 'utf8'), privateKey).toString('base64url');
}

// --- signature path --------------------------------------------------------

test('verify: a signature made over the canonical payload for its own key verifies true', () => {
  const { publicKey, privateKey } = genKeypair();
  const pubkey = rawPubKeyB64url(publicKey);
  const payload = C.postPayload({ handle: 'mrmagoochi', body: 'hello board', parent: null, ts: '2026-01-01T00:00:00Z' });
  const signature = sign(privateKey, payload);
  assert.strictEqual(C.verify(payload, signature, pubkey), true);
});

test('verify: tampering the body after signing makes the signature verify false', () => {
  const { publicKey, privateKey } = genKeypair();
  const pubkey = rawPubKeyB64url(publicKey);
  const original = C.postPayload({ handle: 'mrmagoochi', body: 'the fee-floor assumption was 0.8%', parent: null, ts: '2026-01-01T00:00:00Z' });
  const signature = sign(privateKey, original);
  assert.strictEqual(C.verify(original, signature, pubkey), true, 'sanity: the untampered payload must verify first');
  const tampered = C.postPayload({ handle: 'mrmagoochi', body: 'the fee-floor assumption was 8.0%', parent: null, ts: '2026-01-01T00:00:00Z' });
  assert.strictEqual(C.verify(tampered, signature, pubkey), false);
});

test('verify: a signature made by a different key does not verify against this one', () => {
  const keyA = genKeypair();
  const keyB = genKeypair();
  const payload = C.postPayload({ handle: 'agent-a', body: 'signed by the wrong key', parent: null, ts: '2026-01-01T00:00:00Z' });
  const signatureFromB = sign(keyB.privateKey, payload);
  assert.strictEqual(C.verify(payload, signatureFromB, rawPubKeyB64url(keyA.publicKey)), false);
  // sanity: the same signature does verify against the key that actually made it
  assert.strictEqual(C.verify(payload, signatureFromB, rawPubKeyB64url(keyB.publicKey)), true);
});

test('postPayload: a numeric parent id and its string form produce byte-identical signing input', () => {
  // This is the exact mismatch described at the top of this file. `parent`
  // arrives as a JS number at ingest (freshly parsed from the request) and as
  // a JS string on every later re-verification (a BIGINT column read back
  // through node-pg). postPayload's `parent == null ? null : String(parent)`
  // is what makes those two situations hash the same.
  const fields = { handle: 'sigai', body: 'a reply', ts: '2026-01-02T00:00:00Z' };
  const withNumber = C.postPayload({ ...fields, parent: 2 });
  const withString = C.postPayload({ ...fields, parent: '2' });
  assert.strictEqual(withNumber, withString);
  // Pin the actual bytes, not just mutual agreement between two calls to the
  // same function -- two callers that agree with each other but not with what
  // was historically signed would silently invalidate every already-logged
  // post with a numeric parent.
  assert.strictEqual(withNumber, '{"body":"a reply","handle":"sigai","parent":"2","ts":"2026-01-02T00:00:00Z"}');

  // A signature made while parent was a number must still verify once parent
  // comes back from storage as a string -- that's the property that actually
  // matters, not just that the two payload strings match textually.
  const { publicKey, privateKey } = genKeypair();
  const pubkey = rawPubKeyB64url(publicKey);
  const signature = sign(privateKey, withNumber);
  assert.strictEqual(C.verify(withString, signature, pubkey), true);
});

// --- canonicalisation --------------------------------------------------

test('canonicalise: object keys are sorted independent of insertion order (JCS)', () => {
  assert.strictEqual(C.canonicalise({ b: 1, a: 2 }), C.canonicalise({ a: 2, b: 1 }));
  assert.strictEqual(C.canonicalise({ b: 1, a: 2 }), '{"a":2,"b":1}');
});

// --- RFC 6962 Merkle tree ----------------------------------------------

// crypto.js builds the tree bottom-up: pair adjacent hashes, promote an odd
// one out unchanged, repeat. witness.js's own merkleRoot is the SAME
// bottom-up shape, so it would not catch a bug shared by that shape. The
// reference below is RFC 6962's OTHER definition -- recursive, splitting at
// the largest power of two less than n -- which produces an identical tree
// for any n but gets there structurally differently, so it is a genuinely
// independent cross-check rather than a restatement of the same algorithm.
function sha256(b) { return crypto.createHash('sha256').update(b).digest(); }
function mthRef(leaves) { // leaves are already leaf-hashed, per merkleRoot's own contract
  if (leaves.length === 0) return sha256(Buffer.alloc(0));
  if (leaves.length === 1) return leaves[0];
  let k = 1;
  while (k * 2 < leaves.length) k *= 2;
  const left = mthRef(leaves.slice(0, k));
  const right = mthRef(leaves.slice(k));
  return sha256(Buffer.concat([Buffer.from([0x01]), left, right]));
}

test('leafHash: uses the RFC 6962 leaf domain-separation byte 0x00', () => {
  const data = 'hello';
  const expected = sha256(Buffer.concat([Buffer.from([0x00]), Buffer.from(data, 'utf8')]));
  assert.deepStrictEqual(C.leafHash(data), expected);
});

test('nodeHash: uses the RFC 6962 interior-node domain-separation byte 0x01', () => {
  const l = crypto.randomBytes(32);
  const r = crypto.randomBytes(32);
  const expected = sha256(Buffer.concat([Buffer.from([0x01]), l, r]));
  assert.deepStrictEqual(C.nodeHash(l, r), expected);
});

test('merkleRoot: a leaf can never be presented as an interior node', () => {
  // If the domain-separation byte were ever dropped, combining two leaves
  // would be indistinguishable from hashing them raw.
  const l0 = C.leafHash('a');
  const l1 = C.leafHash('b');
  const root = C.merkleRoot([l0, l1]);
  const withoutDomainSeparation = crypto.createHash('sha256').update(Buffer.concat([l0, l1])).digest('hex');
  assert.notStrictEqual(root, withoutDomainSeparation);
  assert.strictEqual(root, C.nodeHash(l0, l1).toString('hex'));
});

test('merkleRoot: empty log is the hash of the empty string; a single leaf is its own root', () => {
  assert.strictEqual(C.merkleRoot([]), sha256(Buffer.alloc(0)).toString('hex'));
  const leaf = C.leafHash('only post');
  assert.strictEqual(C.merkleRoot([leaf]), leaf.toString('hex'));
});

test('merkleRoot: matches an independent RFC 6962 reimplementation for 0..16 leaves', () => {
  for (let n = 0; n <= 16; n++) {
    const leaves = Array.from({ length: n }, () => crypto.randomBytes(32));
    const got = C.merkleRoot(leaves);
    const want = mthRef(leaves).toString('hex');
    assert.strictEqual(got, want, `mismatch at n=${n}`);
  }
});

test('merkleRoot: recomputing from post content matches a previously published root, and one edited body moves it', () => {
  const posts = Array.from({ length: 5 }, (_, i) => ({
    handle: `agent-${i}`, body: `post number ${i}`, parent: null, ts: `2026-01-0${i + 1}T00:00:00Z`
  }));
  const leavesOf = (ps) => ps.map((p) => C.leafHash(C.postPayload(p)));
  const publishedRoot = C.merkleRoot(leavesOf(posts));
  // A witness re-derives independently, from the same content, later.
  const rederived = C.merkleRoot(leavesOf(posts));
  assert.strictEqual(rederived, publishedRoot);
  // One edited body -- the /tamper demo's whole point -- must move the root.
  const edited = posts.map((p, i) => (i === 2 ? { ...p, body: 'a different body' } : p));
  assert.notStrictEqual(C.merkleRoot(leavesOf(edited)), publishedRoot);
});
