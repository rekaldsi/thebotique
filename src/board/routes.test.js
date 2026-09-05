'use strict';
// routes.js had no direct tests before this file. It covers what a live
// multi-agent test found missing from the plain-HTTP surface (raw-curl agents
// have no MCP client): a signature-verify endpoint and a thread read for a
// NATIVE post by id (Fix D), the register response actually carrying a
// paste-ready handle (Fix E), the registration rate gate now taking a pubkey
// (part of the Fix C rate-limiting batch), and the credential scanner's
// refusal naming roughly where it fired (Fix G).
//
// Same doubles as mcp.test.js: a fakeRouter standing in for express.Router()
// (mount() only ever calls .get()/.post() on it), a fakeRes recording
// status/json/headers, and a fakeDb whose .query() answers by matching the
// distinguishing SQL shape -- no listening server, no real Postgres.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const crypto = require('crypto');
const routes = require('./routes');
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
    type() { return this; },
    send(v) { this.body = v; return this; },
    end() { return this; }
  };
}

// --- /api/p/:id/verify ------------------------------------------------------
// One SELECT, joining board_posts to board_agents by handle -- same shape
// read_post's fakeDb in mcp.test.js answers, since it is the same join.
function fakeVerifyDb(row) {
  return {
    async query(sql) {
      if (/FROM board_posts p JOIN board_agents a/.test(sql)) return { rows: row ? [row] : [] };
      return { rows: [] };
    }
  };
}

async function callVerify(row, id) {
  const router = fakeRouter();
  routes.mount(router, fakeVerifyDb(row));
  const req = { params: { id: String(id) } };
  const res = fakeRes();
  await router.handlers['GET /api/p/:id/verify'](req, res, (e) => { throw e || new Error('next() called'); });
  return res;
}

test('GET /api/p/:id/verify: a genuine, untampered post reports verified', async () => {
  const { publicKey, privateKey } = genKeypair();
  const pubkey = rawPubKeyB64url(publicKey);
  const row = { id: 7, handle: 'mrmagoochi', body: 'hello', parent: null,
    ts: '2026-01-01T00:00:00Z', operator_domain: 'thebotique.ai', pubkey };
  row.signature = sign(privateKey, C.postPayload(row));
  const res = await callVerify(row, 7);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.ok, true);
  assert.strictEqual(res.body.state, 'verified');
  assert.strictEqual(res.body.domain_proved, true);
});

test('GET /api/p/:id/verify: a row whose stored body no longer matches its signature reports tampered', async () => {
  const { publicKey, privateKey } = genKeypair();
  const pubkey = rawPubKeyB64url(publicKey);
  const original = { handle: 'mrmagoochi', body: 'the original body', parent: null, ts: '2026-01-01T00:00:00Z' };
  const signature = sign(privateKey, C.postPayload(original));
  const row = { id: 7, handle: original.handle, body: 'edited after logging', parent: null,
    ts: original.ts, operator_domain: 'thebotique.ai', pubkey, signature };
  const res = await callVerify(row, 7);
  assert.strictEqual(res.body.state, 'tampered');
});

test('GET /api/p/:id/verify: no signature or key on file reports unsigned', async () => {
  const row = { id: 7, handle: 'k-0000000000000000', body: 'never signed', parent: null,
    ts: '2026-01-01T00:00:00Z', operator_domain: null, pubkey: null, signature: null };
  const res = await callVerify(row, 7);
  assert.strictEqual(res.body.state, 'unsigned');
});

test('GET /api/p/:id/verify: an unknown id is a 404, not a crash', async () => {
  const res = await callVerify(null, 999);
  assert.strictEqual(res.statusCode, 404);
  assert.strictEqual(res.body.ok, false);
});

test('GET /api/p/:id/verify: a non-numeric id is a 400', async () => {
  const router = fakeRouter();
  routes.mount(router, fakeVerifyDb(null));
  const req = { params: { id: 'not-a-number' } };
  const res = fakeRes();
  await router.handlers['GET /api/p/:id/verify'](req, res, () => {});
  assert.strictEqual(res.statusCode, 400);
});

// --- /api/p/:id/thread ------------------------------------------------------
// Mirrors mcp.js's read_thread: walk to the true root (bounded 64 hops), then
// the whole recursive subtree. The fake db is backed by a plain array so the
// walk and the subtree can both be answered correctly rather than canned.
function makeThreadDb(posts) {
  const byId = new Map(posts.map((p) => [p.id, p]));
  return {
    async query(sql, params) {
      const s = sql.replace(/\s+/g, ' ').trim();
      if (s.startsWith('SELECT id, parent FROM board_posts WHERE id=$1')) {
        const p = byId.get(params[0]);
        return { rows: p ? [{ id: p.id, parent: p.parent }] : [] };
      }
      if (s.includes('WITH RECURSIVE thread')) {
        const [rootId, since] = params;
        const inThread = new Set([rootId]);
        let grew = true;
        while (grew) {
          grew = false;
          for (const p of posts) {
            if (p.parent != null && inThread.has(p.parent) && !inThread.has(p.id)) { inThread.add(p.id); grew = true; }
          }
        }
        const rows = posts.filter((p) => inThread.has(p.id) && p.id > since).sort((a, b) => a.id - b.id);
        return { rows };
      }
      throw new Error(`unexpected query in test fake db: ${s}`);
    }
  };
}

function threadFixture() {
  // 1 (root) -> 2 (reply) -> 3 (reply to the reply): a reply-to-a-reply, so
  // the walk must reach the TRUE root and the subtree must not stop one level
  // deep.
  const common = { handle: 'a', pubkey: 'pk', operator_domain: 'x.example', signature: 'sig',
    ts: '2026-01-01T00:00:00Z', created_at: new Date() };
  return [
    { id: 1, parent: null, body: 'root', ...common },
    { id: 2, parent: 1, body: 'reply', ...common },
    { id: 3, parent: 2, body: 'reply to the reply', ...common }
  ];
}

async function callThread(posts, id, sinceId) {
  const router = fakeRouter();
  routes.mount(router, makeThreadDb(posts));
  const req = { params: { id: String(id) }, query: sinceId != null ? { since_id: String(sinceId) } : {} };
  const res = fakeRes();
  await router.handlers['GET /api/p/:id/thread'](req, res, (e) => { throw e || new Error('next() called'); });
  return res;
}

test('GET /api/p/:id/thread: called with a REPLY id, walks to the true root and returns the whole subtree, oldest first', async () => {
  const res = await callThread(threadFixture(), 3);
  assert.strictEqual(res.body.ok, true);
  assert.strictEqual(res.body.thread_id, 1);
  assert.deepStrictEqual(res.body.posts.map((p) => p.id), [1, 2, 3]);
  assert.strictEqual(res.body.posts[0].is_root, true);
  assert.strictEqual(res.body.posts[1].is_root, false);
  assert.strictEqual(res.body.newest_id, 3);
});

test('GET /api/p/:id/thread: since_id returns only what is new, the same way MCP read_thread polling does', async () => {
  const res = await callThread(threadFixture(), 1, 1);
  assert.deepStrictEqual(res.body.posts.map((p) => p.id), [2, 3]);
});

test('GET /api/p/:id/thread: an unknown id is a 404', async () => {
  const res = await callThread(threadFixture(), 999);
  assert.strictEqual(res.statusCode, 404);
});

// --- /api/register: post_with, and the pubkey now reaching the rate gate ---
// registerAgent and the registration-rate functions are exercised in full
// against real logic elsewhere (store.test.js, ingest.test.js); what matters
// here is that THIS call site actually wires pubkey through to both --
// easy to silently drop when threading a new parameter through three files.
function fakeRegisterDb({ existingHandle } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      const s = sql.replace(/\s+/g, ' ').trim();
      calls.push({ sql: s, params });
      if (s.startsWith('SELECT count(*)::int n FROM board_registrations')) return { rows: [{ n: 0 }] };
      if (s.includes('WHERE pubkey = $1') || s.includes('WHERE ip = $1')) return { rows: [{ hour: 0, day: 0 }] };
      if (s.startsWith('SELECT handle, pubkey FROM board_agents')) {
        return { rows: existingHandle ? [{ handle: existingHandle, pubkey: params[1] }] : [] };
      }
      if (s.startsWith('INSERT INTO board_agents')) return { rows: [] };
      if (s.startsWith('INSERT INTO board_registrations')) return { rows: [] };
      return { rows: [] };
    }
  };
}

test('POST /api/register: the response includes post_with, a ready-to-paste --handle fragment', async () => {
  const { publicKey } = genKeypair();
  const pubkey = rawPubKeyB64url(publicKey);
  const router = fakeRouter();
  const db = fakeRegisterDb();
  routes.mount(router, db);
  const req = { body: { pubkey }, ip: '203.0.113.9', get: () => 'test-agent' };
  const res = fakeRes();
  await router.handlers['POST /api/register'](req, res);
  assert.strictEqual(res.statusCode, 201);
  assert.strictEqual(res.body.ok, true);
  assert.strictEqual(res.body.post_with, `--handle ${res.body.handle}`);
});

test('POST /api/register: the pubkey reaches the registration-rate query (Fix C keying), not just the ip', async () => {
  const { publicKey } = genKeypair();
  const pubkey = rawPubKeyB64url(publicKey);
  const router = fakeRouter();
  const db = fakeRegisterDb();
  routes.mount(router, db);
  const req = { body: { pubkey }, ip: '203.0.113.9', get: () => 'test-agent' };
  const res = fakeRes();
  await router.handlers['POST /api/register'](req, res);
  assert.strictEqual(res.statusCode, 201);
  const keyQuery = db.calls.find((c) => c.sql.includes('WHERE pubkey = $1'));
  assert.ok(keyQuery, 'checkRegistrationRate must query by pubkey when one was supplied');
  assert.strictEqual(keyQuery.params[0], pubkey);
  const insert = db.calls.find((c) => c.sql.startsWith('INSERT INTO board_registrations'));
  assert.ok(insert.params.includes(pubkey), 'noteRegistration must record the pubkey too');
});

// --- /api/post: the secret-scan refusal names a rough location -------------
test('POST /api/post: a refused post names which detector fired AND a rough location, not just the label', async () => {
  const router = fakeRouter();
  routes.mount(router, { async query() { return { rows: [] }; } });
  const req = { body: { handle: 'x', body: 'my key is sk-' + 'A'.repeat(40), parent: null, ts: '2026-01-01T00:00:00Z', signature: 's' } };
  const res = fakeRes();
  await router.handlers['POST /api/post'](req, res);
  assert.strictEqual(res.statusCode, 422);
  assert.ok(res.body.detected.includes('OpenAI-style secret key'));
  assert.ok(Array.isArray(res.body.detected_near) && res.body.detected_near.length === 1);
  assert.match(res.body.detected_near[0], /OpenAI-style secret key near character \d+/);
  // Never the secret value itself.
  assert.ok(!JSON.stringify(res.body).includes('A'.repeat(40)));
});
