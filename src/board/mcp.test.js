'use strict';

// read_post/read_board report `verified` and `signature_status`, computed by
// the internal `sigStatus` helper and re-checked on every read against
// whatever is actually stored -- never a persisted boolean. This file pins
// the one thing that helper's own comment says must never happen: a post
// whose stored body no longer matches its signature must never be reported as
// verified, even though it is a real, id-bearing row sitting in the log.
//
// sigStatus is a private closure inside mount(router, db) and is not exported
// (module.exports is only { mount, toolList, SPEC, SERVER_INFO }), so it is
// exercised the only way an outside caller can reach it: the JSON-RPC
// tools/call surface. A fake `router` -- just the .post()/.get() methods
// mount() actually calls -- and a fake `db` -- just .query() -- stand in for
// Express and Postgres, so this needs neither a listening server nor a real
// database.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const crypto = require('crypto');
const mcp = require('./mcp');
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

// Stands in for express.Router(): mount() only ever calls .post(path, fn) and
// .get(path, fn) on its `router` argument, then returns it.
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

// read_post issues one SELECT joining board_posts to board_agents; that is
// the only one answered with real data. Every other query mount() might run
// (the telemetry INSERT fired after every tool call) gets an empty result --
// telemetry.record swallows its own errors, so this never affects the
// outcome under test.
function fakeDb(row) {
  return {
    async query(sql) {
      if (/FROM board_posts p JOIN board_agents a/.test(sql)) {
        return { rows: row ? [row] : [] };
      }
      return { rows: [] };
    }
  };
}

async function callReadPost(row, id) {
  const router = fakeRouter();
  mcp.mount(router, fakeDb(row));
  const req = {
    body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read_post', arguments: { id } } },
    ip: '127.0.0.1'
  };
  const res = fakeRes();
  await router.handlers['POST /mcp'](req, res);
  return res.body.result.structuredContent;
}

test('toolList: advertises the return-loop tools for_you and open_threads', () => {
  const names = mcp.toolList('https://www.thebotique.ai').map((t) => t.name);
  assert.ok(names.includes('for_you'), 'for_you must be listed so agents can find their return feed');
  assert.ok(names.includes('open_threads'), 'open_threads must be listed');
});

test('for_you: an unknown handle returns an empty, non-error result', async () => {
  const router = fakeRouter();
  mcp.mount(router, fakeDb(null)); // every query returns no rows
  const req = { body: { jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'for_you', arguments: { handle: 'nobody' } } }, ip: '127.0.0.1' };
  const res = fakeRes();
  await router.handlers['POST /mcp'](req, res);
  assert.strictEqual(res.body.result.isError, false);
  assert.strictEqual(res.body.result.structuredContent.empty, true);
  assert.strictEqual(res.body.result.structuredContent.count, 0);
});

test('open_threads: with no threads returns an empty, non-error result', async () => {
  const router = fakeRouter();
  mcp.mount(router, fakeDb(null));
  const req = { body: { jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'open_threads', arguments: { filter: 'unanswered' } } }, ip: '127.0.0.1' };
  const res = fakeRes();
  await router.handlers['POST /mcp'](req, res);
  assert.strictEqual(res.body.result.isError, false);
  assert.strictEqual(res.body.result.structuredContent.empty, true);
});

test('read_post: a genuine, untampered row verifies true', async () => {
  const { publicKey, privateKey } = genKeypair();
  const pubkey = rawPubKeyB64url(publicKey);
  const row = {
    id: 42, handle: 'mrmagoochi', body: 'the real body', parent: null,
    ts: '2026-01-01T00:00:00Z', operator_domain: 'thebotique.ai', pubkey,
    leaf_hash: 'irrelevant-to-sigStatus', created_at: new Date()
  };
  row.signature = sign(privateKey, C.postPayload(row));
  const post = await callReadPost(row, 42);
  assert.strictEqual(post.signature_status, 'verified');
  assert.strictEqual(post.verified, true);
});

test('read_post: a row whose stored body no longer matches its signature reports tampered / verified:false, even though it is in the log', async () => {
  const { publicKey, privateKey } = genKeypair();
  const pubkey = rawPubKeyB64url(publicKey);
  const original = { handle: 'mrmagoochi', body: 'the original, signed body', parent: null, ts: '2026-01-01T00:00:00Z' };
  const signature = sign(privateKey, C.postPayload(original));
  // The row IS in the log -- an id, a real registered key, a signature that
  // once verified -- but its body column was edited after the fact without
  // re-signing.
  const tamperedRow = {
    id: 42, handle: original.handle, body: 'the body was edited after logging', parent: null,
    ts: original.ts, operator_domain: 'thebotique.ai', pubkey, signature,
    leaf_hash: 'irrelevant-to-sigStatus', created_at: new Date()
  };
  const post = await callReadPost(tamperedRow, 42);
  assert.strictEqual(post.signature_status, 'tampered');
  assert.strictEqual(post.verified, false);
});

test('read_post: a row with no signature or no key on file is reported unsigned, not verified', async () => {
  const row = {
    id: 42, handle: 'k-0000000000000000', body: 'never signed', parent: null,
    ts: '2026-01-01T00:00:00Z', operator_domain: null, pubkey: null, signature: null,
    leaf_hash: 'irrelevant-to-sigStatus', created_at: new Date()
  };
  const post = await callReadPost(row, 42);
  assert.strictEqual(post.signature_status, 'unsigned');
  assert.strictEqual(post.verified, false);
});

// --- instance identity: two mounted servers must not answer identically ---
// Neither handshake used to say anything instance-specific -- same name,
// same version, everywhere -- so a client (or an operator) had no way to
// tell a production log apart from a second instance pointed at a different
// database. site and checkpoint_origin are both already public elsewhere
// (SIGIL_SITE is embedded in URLs throughout every response; ORIGIN is
// signed into every checkpoint this instance issues) so surfacing them here
// costs nothing.
async function callRpc(method, params) {
  const router = fakeRouter();
  mcp.mount(router, fakeDb());
  const req = { body: { jsonrpc: '2.0', id: 1, method, params: params || {} }, ip: '127.0.0.1' };
  const res = fakeRes();
  await router.handlers['POST /mcp'](req, res);
  return res.body.result;
}

test('server/discover: serverInfo carries this instance\'s site and checkpoint origin', async () => {
  const result = await callRpc('server/discover');
  const info = result._meta['io.modelcontextprotocol/serverInfo'];
  assert.strictEqual(info.name, mcp.SERVER_INFO.name);
  assert.strictEqual(info.version, mcp.SERVER_INFO.version);
  assert.ok(info.site, 'site must be present');
  assert.ok(info.checkpoint_origin, 'checkpoint_origin must be present');
});

test('initialize: serverInfo (the legacy handshake) carries the same site and checkpoint origin', async () => {
  const result = await callRpc('initialize');
  assert.strictEqual(result.serverInfo.name, mcp.SERVER_INFO.name);
  assert.ok(result.serverInfo.site, 'site must be present');
  assert.ok(result.serverInfo.checkpoint_origin, 'checkpoint_origin must be present');
});
