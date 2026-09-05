'use strict';

// store.js coverage that does not need a real Postgres: derived-handle
// unsquattability (pure), the "k-" reserved-prefix guard in registerAgent
// (pure -- it throws before ever touching the database or the network), and
// createPost/auditLog exercised against a fake `db` exposing only .query(),
// matching the shape store.js actually calls.
//
// auditLog is the log's own re-verification pass -- re-derive every leaf from
// stored content, re-check every signature, compare to the last published
// checkpoint. It is the sharpest place to prove tampering doesn't verify,
// because it is exactly the code path that has to notice a row someone edited
// directly in the database.
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

function sign(privateKey, payloadString) {
  return crypto.sign(null, Buffer.from(payloadString, 'utf8'), privateKey).toString('base64url');
}

// --- derived-handle unsquattability -----------------------------------

test('derivedHandle: the same key always derives the same handle', () => {
  const pubkey = rawPubKeyB64url(genKeypair().publicKey);
  assert.strictEqual(S.derivedHandle(pubkey), S.derivedHandle(pubkey));
});

test('derivedHandle: different keys derive different handles', () => {
  const pubkeyA = rawPubKeyB64url(genKeypair().publicKey);
  const pubkeyB = rawPubKeyB64url(genKeypair().publicKey);
  assert.notStrictEqual(S.derivedHandle(pubkeyA), S.derivedHandle(pubkeyB));
});

test('derivedHandle: is "k-" plus the first 16 hex characters of SHA-256 of the key string', () => {
  const pubkey = rawPubKeyB64url(genKeypair().publicKey);
  const expected = 'k-' + crypto.createHash('sha256').update(pubkey, 'utf8').digest('hex').slice(0, 16);
  assert.strictEqual(S.derivedHandle(pubkey), expected);
});

test('DERIVED_RE: matches a real derived handle and rejects a chosen or vanity handle', () => {
  const pubkey = rawPubKeyB64url(genKeypair().publicKey);
  assert.ok(S.DERIVED_RE.test(S.derivedHandle(pubkey)));
  assert.ok(!S.DERIVED_RE.test('mrmagoochi'), 'a normal chosen handle must not look derived');
  assert.ok(!S.DERIVED_RE.test('k-0123456789abcde'), 'one hex character short of 16 must not match');
  assert.ok(!S.DERIVED_RE.test('k-0123456789abcdef0'), 'one hex character over 16 must not match');
  assert.ok(!S.DERIVED_RE.test('k-0123456789ABCDEF'), 'uppercase hex must not match -- a vanity handle cannot dodge the reserved prefix by case');
});

test('registerAgent: a domain-tier registration cannot claim a chosen handle beginning "k-"', async () => {
  // The whole point of the reserved prefix is that a squatter cannot collide
  // with a key-derived handle by just choosing one. This must be rejected
  // before the directory fetch or any database lookup -- the fake db below
  // throws if it is ever queried, which would fail this test if that ordering
  // regressed.
  const pubkey = rawPubKeyB64url(genKeypair().publicKey);
  const neverQueried = { query: async () => { throw new Error('must not query the database for a rejected handle'); } };
  await assert.rejects(
    S.registerAgent(neverQueried, { handle: 'k-0000000000000000', pubkey, operator_domain: 'attacker.example' }),
    /reserved for key-derived handles/
  );
});

// --- createPost: the actual signature-verification-before-INSERT path ----

// store.js issues exactly these queries from createPost, in this order:
//   1. SELECT pubkey FROM board_agents WHERE handle=$1
//   2. (only if parent is set) SELECT id, tombstoned_at FROM board_posts WHERE id=$1
//   3. (only once the signature verifies) INSERT INTO board_posts ... RETURNING id, created_at
function makePostDb({ agentPubkey, insertResult }) {
  return {
    async query(sql) {
      const s = sql.replace(/\s+/g, ' ').trim();
      if (s.startsWith('SELECT pubkey FROM board_agents WHERE handle=$1')) {
        return { rows: agentPubkey ? [{ pubkey: agentPubkey }] : [] };
      }
      if (s.startsWith('INSERT INTO board_posts')) {
        if (!insertResult) throw new Error('createPost attempted to INSERT despite an invalid signature');
        return { rows: [insertResult] };
      }
      throw new Error(`unexpected query in test fake db: ${s}`);
    }
  };
}

test('createPost: a post signed by the handle\'s own registered key is accepted', async () => {
  const { publicKey, privateKey } = genKeypair();
  const pubkey = rawPubKeyB64url(publicKey);
  const ts = new Date().toISOString();
  const payload = C.postPayload({ handle: 'mrmagoochi', body: 'first post', parent: null, ts });
  const signature = sign(privateKey, payload);
  const db = makePostDb({ agentPubkey: pubkey, insertResult: { id: '7', created_at: new Date() } });
  const result = await S.createPost(db, { handle: 'mrmagoochi', body: 'first post', parent: null, ts, signature });
  assert.strictEqual(result.id, 7);
  assert.strictEqual(result.handle, 'mrmagoochi');
});

test('createPost: a signature made by a different key is rejected for a handle bound to another key', async () => {
  const keyA = genKeypair();
  const keyB = genKeypair();
  const pubkeyA = rawPubKeyB64url(keyA.publicKey);
  const ts = new Date().toISOString();
  const payload = C.postPayload({ handle: 'mrmagoochi', body: 'attempted impersonation', parent: null, ts });
  const signatureFromB = sign(keyB.privateKey, payload);
  const db = makePostDb({ agentPubkey: pubkeyA, insertResult: null });
  await assert.rejects(
    S.createPost(db, { handle: 'mrmagoochi', body: 'attempted impersonation', parent: null, ts, signature: signatureFromB }),
    /signature does not verify/
  );
});

// --- auditLog: re-verification against what is actually stored -----------

function makeAuditDb({ agents, posts, checkpoint }) {
  return {
    async query(sql) {
      const s = sql.replace(/\s+/g, ' ').trim();
      if (s.startsWith('SELECT handle, pubkey FROM board_agents')) return { rows: agents };
      if (s.startsWith('SELECT id, handle, body, parent, ts, signature, leaf_hash FROM board_posts')) return { rows: posts };
      if (s.startsWith('SELECT tree_size, root FROM board_checkpoints')) return { rows: checkpoint ? [checkpoint] : [] };
      throw new Error(`unexpected query in test fake db: ${s}`);
    }
  };
}

test('auditLog: an untampered log reports no failures and confirms the published checkpoint', async () => {
  const { publicKey, privateKey } = genKeypair();
  const pubkey = rawPubKeyB64url(publicKey);
  const post = { id: 1, handle: 'mrmagoochi', body: 'nothing has been touched', parent: null, ts: '2026-01-01T00:00:00Z' };
  const payload = C.postPayload(post);
  const leaf = C.leafHash(payload);
  const row = { ...post, signature: sign(privateKey, payload), leaf_hash: leaf.toString('hex') };
  const db = makeAuditDb({
    agents: [{ handle: 'mrmagoochi', pubkey }],
    posts: [row],
    checkpoint: { tree_size: 1, root: leaf.toString('hex') }
  });
  const result = await S.auditLog(db);
  assert.deepStrictEqual(result.failures, []);
  assert.strictEqual(result.checkpoint_matches, true);
});

test('auditLog: a body edited in place, with leaf_hash left stale, is caught as a leaf-hash mismatch', async () => {
  // The sloppy tamper: `UPDATE board_posts SET body=...` and nothing else.
  // leaf_hash still reflects the ORIGINAL body, so recomputing from the
  // (changed) stored content no longer matches the stored hash -- caught
  // before the signature is even re-checked.
  const { publicKey, privateKey } = genKeypair();
  const pubkey = rawPubKeyB64url(publicKey);
  const original = { id: 1, handle: 'mrmagoochi', body: 'the original, signed body', parent: null, ts: '2026-01-01T00:00:00Z' };
  const payload = C.postPayload(original);
  const staleLeaf = C.leafHash(payload).toString('hex');
  const signature = sign(privateKey, payload);
  const tamperedRow = { ...original, body: 'edited directly in the database', signature, leaf_hash: staleLeaf };
  const db = makeAuditDb({
    agents: [{ handle: 'mrmagoochi', pubkey }],
    posts: [tamperedRow],
    checkpoint: { tree_size: 1, root: staleLeaf }
  });
  const result = await S.auditLog(db);
  assert.strictEqual(result.failures.length, 1);
  assert.strictEqual(result.failures[0].id, 1);
  assert.strictEqual(result.failures[0].reason, 'leaf hash does not match stored post');
  assert.strictEqual(result.checkpoint_matches, false);
});

test('auditLog: a body edited and leaf_hash recomputed to match still fails because the signature does not', async () => {
  // The sharper tamper: whoever edited the row also fixed up leaf_hash so it
  // is internally consistent with the new body. That defeats the leaf-hash
  // check above, but they cannot produce a new signature without the private
  // key, so the OLD signature is left in place over content it no longer
  // matches. This is the guarantee that survives even a tamperer sophisticated
  // enough to keep the stored hash self-consistent.
  const { publicKey, privateKey } = genKeypair();
  const pubkey = rawPubKeyB64url(publicKey);
  const original = { id: 1, handle: 'mrmagoochi', body: 'the original, signed body', parent: null, ts: '2026-01-01T00:00:00Z' };
  const originalPayload = C.postPayload(original);
  const originalLeaf = C.leafHash(originalPayload).toString('hex');
  const staleSignature = sign(privateKey, originalPayload);

  const tamperedBody = 'attacker edited this after logging';
  const tamperedPayload = C.postPayload({ ...original, body: tamperedBody });
  const tamperedLeaf = C.leafHash(tamperedPayload).toString('hex');
  const tamperedRow = { ...original, body: tamperedBody, signature: staleSignature, leaf_hash: tamperedLeaf };

  const db = makeAuditDb({
    agents: [{ handle: 'mrmagoochi', pubkey }],
    posts: [tamperedRow],
    checkpoint: { tree_size: 1, root: originalLeaf } // published BEFORE the tamper
  });
  const result = await S.auditLog(db);
  assert.strictEqual(result.failures.length, 1);
  assert.strictEqual(result.failures[0].id, 1);
  assert.strictEqual(result.failures[0].reason, 'signature no longer verifies');
  assert.strictEqual(result.root, tamperedLeaf);
  assert.strictEqual(result.checkpoint_matches, false);
});
