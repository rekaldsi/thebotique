'use strict';

// Checkpoint signing and verification -- the piece of store.js that lets a
// third party (a witness, or anyone who kept a copy) attribute a checkpoint
// to this log and catch a later edit to it. Covers noteBody's wire format,
// buildCheckpoint's commitment to tree_size/root and its signature,
// serialiseCheckpoint/verifyCheckpoint round-tripping that signature, and
// logPublicKey matching the public half of SIGIL_LOG_KEY.
//
// store.js's logKey() re-reads process.env.SIGIL_LOG_KEY on every call --
// there is no module-level cache -- so each test below sets it to its own
// freshly generated keypair via withLogKey() and restores whatever was
// there before, even on failure. These are the only tests in this suite
// that touch process.env.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const crypto = require('crypto');
const S = require('./store');
const C = require('./crypto');

function genKeypair() {
  return crypto.generateKeyPairSync('ed25519');
}

function rawPubKeyB64url(publicKey) {
  return publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('base64url');
}

function pemOf(privateKey) {
  return privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
}

async function withLogKey(pem, fn) {
  const prev = process.env.SIGIL_LOG_KEY;
  if (pem === undefined) delete process.env.SIGIL_LOG_KEY; else process.env.SIGIL_LOG_KEY = pem;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.SIGIL_LOG_KEY; else process.env.SIGIL_LOG_KEY = prev;
  }
}

// buildCheckpoint issues exactly these two queries, via leavesFromContent()
// and then its own INSERT.
function makeCheckpointDb({ posts = [] } = {}) {
  return {
    async query(sql) {
      const s = sql.replace(/\s+/g, ' ').trim();
      if (s.startsWith('SELECT id, handle, body, parent, ts, signature, leaf_hash FROM board_posts')) {
        return { rows: posts };
      }
      if (s.startsWith('INSERT INTO board_checkpoints')) {
        return { rows: [{ id: '1', created_at: new Date() }] };
      }
      throw new Error(`unexpected query in test fake db: ${s}`);
    }
  };
}

// --- noteBody: the transparency-dev signed-note wire format ---------------

test('noteBody: origin, tree size and base64 root, each on its own line', () => {
  const root = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'; // sha256(""), a fixed known value
  const body = S.noteBody({ origin: 'sigil.thebotique.ai', tree_size: 3, root });
  // '47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=' is sha256("") in base64,
  // verified independently via shasum, openssl and python's hashlib+base64 --
  // not derived from noteBody's own Buffer.from(root,'hex') call.
  assert.strictEqual(body, 'sigil.thebotique.ai\n3\n47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=\n');
});

// --- buildCheckpoint: signs over content-derived tree_size/root -----------

test('buildCheckpoint: signs the note with SIGIL_LOG_KEY, and tree_size/root are re-derived from stored content', async () => {
  const { publicKey, privateKey } = genKeypair();
  const posts = [
    { id: 1, handle: 'mrmagoochi', body: 'first', parent: null, ts: '2026-01-01T00:00:00Z' },
    { id: 2, handle: 'mrmagoochi', body: 'second', parent: 1, ts: '2026-01-02T00:00:00Z' }
  ];
  const expectedRoot = C.merkleRoot(posts.map((p) => C.leafHash(C.postPayload(p))));
  const db = makeCheckpointDb({ posts });
  const cp = await withLogKey(pemOf(privateKey), () => S.buildCheckpoint(db));

  assert.strictEqual(cp.tree_size, 2);
  assert.strictEqual(cp.root, expectedRoot);
  assert.strictEqual(cp.signed, true);
  assert.ok(cp.signature);

  // The signature covers exactly noteBody(cp) -- checked here independently
  // of verifyCheckpoint/serialiseCheckpoint, straight off node's own crypto.verify.
  const ok = crypto.verify(null, Buffer.from(S.noteBody(cp), 'utf8'), publicKey, Buffer.from(cp.signature, 'base64'));
  assert.strictEqual(ok, true);
});

test('buildCheckpoint: with no SIGIL_LOG_KEY configured, the checkpoint is stored unsigned rather than falsely signed', async () => {
  const db = makeCheckpointDb({ posts: [] });
  const cp = await withLogKey(undefined, () => S.buildCheckpoint(db));
  assert.strictEqual(cp.signed, false);
  assert.strictEqual(cp.signature, null);
  assert.strictEqual(cp.key_id, null);
  assert.strictEqual(cp.tree_size, 0);
  assert.strictEqual(cp.root, C.merkleRoot([])); // hash of nothing -- still a real, checkable root
});

// --- logPublicKey / key_id --------------------------------------------

test('logPublicKey: matches the public half of SIGIL_LOG_KEY', async () => {
  const { publicKey, privateKey } = genKeypair();
  const expected = rawPubKeyB64url(publicKey); // derived straight from the keypair, not via store.js
  const got = await withLogKey(pemOf(privateKey), () => S.logPublicKey());
  assert.strictEqual(got, expected);
});

test('logPublicKey: returns null when no log key is configured', async () => {
  const got = await withLogKey(undefined, () => S.logPublicKey());
  assert.strictEqual(got, null);
});

test('buildCheckpoint: key_id is the first 12 base64url characters of the log\'s own public key -- NOT an RFC 7638 JWK thumbprint', async () => {
  // This codebase does compute an RFC 7638 thumbprint elsewhere (an agent's
  // own key-directory `kid`, in src/sigil/wellknown.js), but the checkpoint's
  // key_id is a different, simpler thing: crypto.js:key_id computes it as
  // rawPublicKey.slice(0,12). Pinning what it actually is, not what a
  // thumbprint-shaped name might suggest it is.
  const { privateKey } = genKeypair();
  const db = makeCheckpointDb({ posts: [] });
  const { keyId, pub } = await withLogKey(pemOf(privateKey), async () => {
    const built = await S.buildCheckpoint(db);
    return { keyId: built.key_id, pub: S.logPublicKey() };
  });
  assert.strictEqual(keyId, pub.slice(0, 12));
});

// --- serialiseCheckpoint / verifyCheckpoint: round trip + byte-exactness --

test('serialiseCheckpoint: round-trips origin, tree size, base64 root and the signature line, and verifyCheckpoint accepts it', async () => {
  const { publicKey, privateKey } = genKeypair();
  const logPubkey = rawPubKeyB64url(publicKey);
  const db = makeCheckpointDb({ posts: [{ id: 1, handle: 'agent', body: 'hello', parent: null, ts: '2026-01-01T00:00:00Z' }] });
  const cp = await withLogKey(pemOf(privateKey), () => S.buildCheckpoint(db));
  const note = S.serialiseCheckpoint(cp);

  // transparency-dev signed-note shape: origin \n tree_size \n base64(root) \n
  // \n "— origin key_id signature" \n
  const lines = note.split('\n');
  assert.strictEqual(lines[0], cp.origin);
  assert.strictEqual(lines[1], String(cp.tree_size));
  assert.strictEqual(lines[2], Buffer.from(cp.root, 'hex').toString('base64'));
  assert.strictEqual(lines[3], '');
  assert.strictEqual(lines[4], `— ${cp.origin} ${cp.key_id} ${cp.signature}`);

  assert.deepStrictEqual(S.verifyCheckpoint(note, logPubkey), { ok: true });
});

test('verifyCheckpoint: the signature is checked against exactly noteBody\'s bytes, not a re-rendered variant', async () => {
  const { publicKey, privateKey } = genKeypair();
  const db = makeCheckpointDb({ posts: [] });
  const cp = await withLogKey(pemOf(privateKey), () => S.buildCheckpoint(db));

  // Re-derive the canonical body straight from the committed fields --
  // independent of serialiseCheckpoint's own rendering -- and check the
  // signature against exactly those bytes.
  const rederivedBody = S.noteBody({ origin: cp.origin, tree_size: cp.tree_size, root: cp.root });
  const ok = crypto.verify(null, Buffer.from(rederivedBody, 'utf8'), publicKey, Buffer.from(cp.signature, 'base64'));
  assert.strictEqual(ok, true);

  // A differently-rendered body carrying the identical fields -- missing only
  // noteBody's trailing newline -- is NOT what was signed. Pins that
  // verification is byte-exact, not "the same fields in some format".
  const missingTrailingNewline = `${cp.origin}\n${cp.tree_size}\n${Buffer.from(cp.root, 'hex').toString('base64')}`;
  const stillOk = crypto.verify(null, Buffer.from(missingTrailingNewline, 'utf8'), publicKey, Buffer.from(cp.signature, 'base64'));
  assert.strictEqual(stillOk, false, 'the trailing newline is part of the signed bytes, not incidental formatting');
});

// --- tamper: flipping the root, or changing tree_size, must fail ----------

test('verifyCheckpoint: flipping one byte of the root hash makes a genuinely-signed checkpoint fail to verify', async () => {
  const { publicKey, privateKey } = genKeypair();
  const logPubkey = rawPubKeyB64url(publicKey);
  const db = makeCheckpointDb({ posts: [{ id: 1, handle: 'agent', body: 'x', parent: null, ts: '2026-01-01T00:00:00Z' }] });
  const cp = await withLogKey(pemOf(privateKey), () => S.buildCheckpoint(db));
  assert.strictEqual(S.verifyCheckpoint(S.serialiseCheckpoint(cp), logPubkey).ok, true,
    'sanity: the untampered checkpoint must verify first');

  const tamperedRoot = (cp.root[0] === 'a' ? 'b' : 'a') + cp.root.slice(1);
  // Same signature, same origin, same tree_size -- only the committed root
  // hash differs, which is exactly the byte range the signature covers.
  const tamperedNote = S.serialiseCheckpoint({ ...cp, root: tamperedRoot });
  const result = S.verifyCheckpoint(tamperedNote, logPubkey);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'signature does not verify');
});

test('verifyCheckpoint: changing tree_size makes a genuinely-signed checkpoint fail to verify', async () => {
  const { publicKey, privateKey } = genKeypair();
  const logPubkey = rawPubKeyB64url(publicKey);
  const db = makeCheckpointDb({ posts: [{ id: 1, handle: 'agent', body: 'x', parent: null, ts: '2026-01-01T00:00:00Z' }] });
  const cp = await withLogKey(pemOf(privateKey), () => S.buildCheckpoint(db));

  const tamperedNote = S.serialiseCheckpoint({ ...cp, tree_size: cp.tree_size + 1 });
  const result = S.verifyCheckpoint(tamperedNote, logPubkey);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'signature does not verify');
});

test('the checkpoint\'s created_at is DB metadata, not signed content -- noteBody commits no timestamp', async () => {
  // Discrepancy from this pass's brief, recorded as a pinned behaviour rather
  // than bent to fit: the brief expected tampering "the timestamp" to flip
  // verification to false, as if a timestamp were part of the committed
  // note. noteBody (above) commits only origin/tree_size/root; created_at is
  // a board_checkpoints column populated by the database default and handed
  // back to the caller, but it is never passed through noteBody. Two
  // checkpoints built from identical content, differing only in created_at,
  // serialise to the byte-identical signed note.
  const { privateKey } = genKeypair();
  const db = makeCheckpointDb({ posts: [{ id: 1, handle: 'agent', body: 'x', parent: null, ts: '2026-01-01T00:00:00Z' }] });
  const cp = await withLogKey(pemOf(privateKey), () => S.buildCheckpoint(db));
  const noteA = S.serialiseCheckpoint({ ...cp, created_at: new Date('2020-01-01') });
  const noteB = S.serialiseCheckpoint({ ...cp, created_at: new Date('2099-01-01') });
  assert.strictEqual(noteA, noteB);
});

// --- malformed / wrong-key checkpoint verification -------------------------

test('verifyCheckpoint: a note with no signature line is rejected, not verified', () => {
  const note = S.noteBody({ origin: 'sigil.thebotique.ai', tree_size: 0, root: C.merkleRoot([]) });
  const result = S.verifyCheckpoint(note, rawPubKeyB64url(genKeypair().publicKey));
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'note carries no signature');
});

test('verifyCheckpoint: a checkpoint signed by a different log key does not verify against this one', async () => {
  const keyA = genKeypair();
  const keyB = genKeypair();
  const db = makeCheckpointDb({ posts: [] });
  const cp = await withLogKey(pemOf(keyA.privateKey), () => S.buildCheckpoint(db));
  const note = S.serialiseCheckpoint(cp);
  assert.strictEqual(S.verifyCheckpoint(note, rawPubKeyB64url(keyA.publicKey)).ok, true,
    'sanity: verifies against the key that actually signed it');
  assert.strictEqual(S.verifyCheckpoint(note, rawPubKeyB64url(keyB.publicKey)).ok, false);
});
