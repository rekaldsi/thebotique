'use strict';

// verify_post (src/board/mcp.js) is the one MCP tool that answers "is this
// signed?" for text from anywhere, not just this board -- so its own
// verdict had better not waffle. It wraps envelope.js's verifyContent (see
// src/sigil/envelope.test.js for that layer) and, for a signed envelope that
// claims a domain, asks src/sigil/directory.js's confirmsKey whether that
// domain actually publishes the key.
//
// A P1 shipped to PRODUCTION with this inverted (ops/qa/FINDINGS.md, [M1]):
// the structured domain_confirmation field and the human-readable prose both
// tested confirmsKey()'s RETURN VALUE for truthiness (always an object,
// always truthy) instead of its .confirmed boolean, so an unpublished-key
// domain claim was reported as confirmed anyway. The current code guards on
// .confirmed, not on the object -- this file locks the correct direction
// down so it cannot regress silently.
//
// verify_post is not exported from mcp.js (only mount/toolList/SPEC/
// SERVER_INFO are); it is reached the only way an outside caller can reach
// it, the same way mcp.test.js drives sigStatus: a fake router (just the
// .post()/.get() methods mount() actually calls) and a fake db (just
// .query()), through the JSON-RPC tools/call envelope.
//
// directory.js's confirmsKey does real DNS + HTTPS. Nothing here touches the
// network: mcp.js does `const D = require('../sigil/directory')` and calls
// D.confirmsKey(...) as a property lookup at call time, never destructured,
// so overwriting that property on the same, require-cache-shared module
// object substitutes a fake for the real network call. Every test that does
// this restores the original in a finally block.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const mcp = require('./mcp');
const E = require('../sigil/envelope');
const D = require('../sigil/directory');

function fakeRouter() {
  const handlers = {};
  return {
    post(path, fn) { handlers[`POST ${path}`] = fn; return this; },
    get(path, fn) { handlers[`GET ${path}`] = fn; return this; },
    handlers
  };
}

function fakeRes() {
  return {
    statusCode: 200,
    body: undefined,
    headers: {},
    set(k, v) { this.headers[k] = v; return this; },
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; },
    end() { return this; }
  };
}

// verify_post issues a board_posts query of its own only when E.verifyContent
// comes back "unsigned" -- the native-board-post lookup added below -- and
// otherwise none at all; the only query mount() always runs on its behalf is
// telemetry's INSERT after the call, which swallows its own errors (see
// telemetry.js). An empty-rows stub for everything is enough for every test
// that is not exercising that lookup directly, matching mcp.test.js's own
// fakeDb fallback.
function fakeDb() {
  return { async query() { return { rows: [] }; } };
}

// For the native-board-post lookup: answers the exact query verify_post
// issues (SELECT id FROM board_posts WHERE body = $1 LIMIT 1) with a match
// when the queried body equals `body`, and no rows otherwise -- so a test can
// drive both the match and the no-match path through the real query shape
// rather than a blanket stub.
function fakeDbWithPost(body, id) {
  return {
    async query(sql, params) {
      const s = sql.replace(/\s+/g, ' ').trim();
      if (s.startsWith('SELECT id FROM board_posts WHERE body')) {
        return { rows: params && params[0] === body ? [{ id }] : [] };
      }
      return { rows: [] };
    }
  };
}

async function withConfirmsKey(mockImpl, fn) {
  const original = D.confirmsKey;
  D.confirmsKey = mockImpl;
  try {
    return await fn();
  } finally {
    D.confirmsKey = original;
  }
}

async function callVerifyPost(text, author, db) {
  const router = fakeRouter();
  mcp.mount(router, db || fakeDb());
  const req = {
    body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'verify_post', arguments: author ? { text, author } : { text } } },
    ip: '127.0.0.1'
  };
  const res = fakeRes();
  await router.handlers['POST /mcp'](req, res);
  return res.body.result; // { content, structuredContent, isError }
}

// --- a well-formed post verifies true, tampering flips it false -----------

test('verify_post: a well-formed signed post verifies true', async () => {
  const { privateKeyPem, publicKeyRaw } = E.generateKeypair();
  const { content } = E.signPost({ handle: 'mrmagoochi', body: 'hello board', privateKeyPem, ts: '2026-01-01T00:00:00Z' });
  const result = await callVerifyPost(content, 'mrmagoochi');
  assert.strictEqual(result.isError, false);
  assert.strictEqual(result.structuredContent.outcome, 'verified');
  assert.strictEqual(result.structuredContent.pubkey, publicKeyRaw);
});

test('verify_post: tampering the content flips the verdict to tampered, never verified', async () => {
  const { privateKeyPem } = E.generateKeypair();
  const { content } = E.signPost({ handle: 'mrmagoochi', body: 'the fee-floor assumption was 0.8%', privateKeyPem, ts: '2026-01-01T00:00:00Z' });
  const tampered = content.replace('0.8%', '8.0%');
  const result = await callVerifyPost(tampered, 'mrmagoochi');
  assert.strictEqual(result.structuredContent.outcome, 'tampered');
  assert.notStrictEqual(result.structuredContent.outcome, 'verified');
});

// --- the domain verdict: correct direction, not inverted ------------------

test('verify_post: a domain that genuinely confirms the key reports domain_confirmation true, and prose says so', async () => {
  const { privateKeyPem, publicKeyRaw } = E.generateKeypair();
  const { content } = E.signPost({
    handle: 'mrmagoochi', body: 'domain-proved post', privateKeyPem, ts: '2026-01-01T00:00:00Z', domain: 'thebotique.ai'
  });
  let calledWith = null;
  const result = await withConfirmsKey(
    async (domain, pubkey) => {
      calledWith = { domain, pubkey };
      return { confirmed: true, url: 'https://thebotique.ai/.well-known/http-message-signatures-directory' };
    },
    () => callVerifyPost(content, 'mrmagoochi')
  );
  assert.deepStrictEqual(calledWith, { domain: 'thebotique.ai', pubkey: publicKeyRaw });
  assert.strictEqual(result.structuredContent.outcome, 'verified');
  assert.strictEqual(result.structuredContent.domain, 'thebotique.ai');
  assert.strictEqual(result.structuredContent.domain_confirmation, true);
  assert.match(result.content[0].text, /and it does publish this key/);
});

test('verify_post: a domain that does NOT confirm the key reports domain_confirmation false -- the verdict is not inverted', async () => {
  // The exact regression class from ops/qa/FINDINGS.md [M1]: confirmsKey()
  // always returns an object (truthy), even when confirmed is false. A stub
  // that returns a truthy object with confirmed:false is exactly the shape
  // that inverted implementation got backwards -- it would have reported
  // this as confirmed.
  const { privateKeyPem } = E.generateKeypair();
  const { content } = E.signPost({
    handle: 'mrmagoochi', body: 'claims a domain that does not actually list this key', privateKeyPem, ts: '2026-01-01T00:00:00Z', domain: 'thebotique.ai'
  });
  const result = await withConfirmsKey(
    async () => ({ confirmed: false, reason: 'key is not listed at https://thebotique.ai/.well-known/http-message-signatures-directory' }),
    () => callVerifyPost(content, 'mrmagoochi')
  );
  assert.strictEqual(result.structuredContent.domain_confirmation, false);
  assert.notStrictEqual(result.structuredContent.domain_confirmation, true);
  assert.match(result.content[0].text, /does NOT publish this key/);
  assert.doesNotMatch(result.content[0].text, /and it does publish this key/);
});

test('verify_post: a self-registered post with no domain claim reports domain/domain_confirmation as null, and never calls confirmsKey', async () => {
  const { privateKeyPem } = E.generateKeypair();
  const handle = 'k-0123456789abcdef'; // shape of a derived, self-registered handle -- see store.js DERIVED_RE
  const { content } = E.signPost({ handle, body: 'nothing to squat, nothing claimed', privateKeyPem, ts: '2026-01-01T00:00:00Z' });
  const result = await withConfirmsKey(
    async () => { throw new Error('confirmsKey must not be called when no domain was claimed'); },
    () => callVerifyPost(content, handle)
  );
  assert.strictEqual(result.structuredContent.outcome, 'verified');
  assert.strictEqual(result.structuredContent.domain, null);
  assert.strictEqual(result.structuredContent.domain_confirmation, null);
  assert.doesNotMatch(result.content[0].text, /Domain claimed/);
});

// --- wrong-key, malformed, missing-signature: never verified --------------

test('verify_post: a wrong-key signature is reported not-verified (tampered), never verified', async () => {
  const keyA = E.generateKeypair();
  const keyB = E.generateKeypair();
  const { content } = E.signPost({ handle: 'agent-a', body: 'signed by the wrong key', privateKeyPem: keyA.privateKeyPem, ts: '2026-01-01T00:00:00Z' });
  const forged = content.replace(keyA.publicKeyRaw, keyB.publicKeyRaw);
  const result = await callVerifyPost(forged, 'agent-a');
  assert.strictEqual(result.structuredContent.outcome, 'tampered');
  assert.notStrictEqual(result.structuredContent.outcome, 'verified');
});

test('verify_post: a malformed envelope is reported not-verified (malformed), never verified', async () => {
  const text = 'hello\n\n⟦sigil/1 a=someone t=2026-01-01T00:00:00Z n=abc123 k=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA⟧';
  const result = await callVerifyPost(text);
  assert.strictEqual(result.structuredContent.outcome, 'malformed');
  assert.notStrictEqual(result.structuredContent.outcome, 'verified');
});

test('verify_post: text with no signature at all is reported unsigned, never verified', async () => {
  const result = await callVerifyPost('just some ordinary text, never signed');
  assert.strictEqual(result.structuredContent.outcome, 'unsigned');
  assert.notStrictEqual(result.structuredContent.outcome, 'verified');
});

// --- no envelope, but it IS a native board post: not the same as unsigned ---
// This board never appends a sigil/1 envelope to a post body -- it verifies
// {body, handle, parent, ts} directly against a stored signature -- so a
// pasted native post has no envelope for E.verifyContent to find and, before
// this fix, came back "unsigned" indistinguishably from ordinary unsigned
// prose. That reads as a failed check on a post that is, in fact, signed and
// stored. The two cases below pin both branches of the fix: an exact stored
// match gets a distinct, honest outcome pointing at how to actually check
// it; no match at all still reports unsigned, with the ambiguity explained
// rather than silently assumed away.

test('verify_post: text with no envelope that exactly matches a stored post body is reported as a native board post, not unsigned', async () => {
  const body = 'the fee-floor assumption was 0.8%, posted natively with no envelope at all';
  const db = fakeDbWithPost(body, 42);
  const result = await callVerifyPost(body, undefined, db);
  assert.strictEqual(result.isError, false);
  assert.strictEqual(result.structuredContent.outcome, 'no_envelope_native_post');
  assert.notStrictEqual(result.structuredContent.outcome, 'unsigned');
  assert.strictEqual(result.structuredContent.post_id, 42);
  assert.match(result.content[0].text, /board post #42/);
  assert.match(result.content[0].text, /read_post\(42\)/);
});

test('verify_post: text with no envelope and no matching stored post is still reported unsigned, with the envelope-vs-native ambiguity explained', async () => {
  const db = fakeDbWithPost('some other post entirely', 99); // deliberately does not match
  const result = await callVerifyPost('never posted here, never signed anywhere', undefined, db);
  assert.strictEqual(result.structuredContent.outcome, 'unsigned');
  assert.strictEqual(result.structuredContent.post_id, undefined);
  assert.match(result.content[0].text, /no exact match among this board/);
});

test('verify_post: a missing text argument fails cleanly rather than verifying', async () => {
  const router = fakeRouter();
  mcp.mount(router, fakeDb());
  const req = { body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'verify_post', arguments: {} } }, ip: '127.0.0.1' };
  const res = fakeRes();
  await router.handlers['POST /mcp'](req, res);
  assert.strictEqual(res.body.result.isError, true);
});
