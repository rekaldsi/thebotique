'use strict';
// /verify and /api/verify used to accept ONLY a Moltbook post id: the page
// fetched that post and checked the signature inside it. This covers the added
// path -- a signed post pasted verbatim is checked directly, with nothing
// fetched -- so the endpoint verifies any signed post, from this board, X, or
// anywhere. Same doubles as the board tests: a fakeRouter capturing the
// handlers mount() registers, and a fakeRes recording what a handler returned.
// No listening server; no network (the posts below carry no domain, so the
// directory lookup is never reached).
const assert = require('node:assert/strict');
const { test } = require('node:test');
const routes = require('./routes');
const E = require('./envelope');

function fakeRouter() {
  const handlers = {};
  return {
    get(path, fn) { handlers[`GET ${path}`] = fn; return this; },
    post(path, fn) { handlers[`POST ${path}`] = fn; return this; },
    handlers
  };
}
function fakeRes() {
  return {
    statusCode: 200, body: undefined, html: undefined,
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
    send(h) { this.html = h; return this; },
    set() { return this; }, type() { return this; }
  };
}
function handlers() {
  const r = fakeRouter();
  routes.mount(r);
  return r.handlers;
}
function signedPost(body, handle = 'k-pastetest') {
  const { privateKeyPem } = E.generateKeypair();
  return E.signPost({ handle, body, privateKeyPem, ts: '2026-01-01T00:00:00Z' }).content;
}

test('/api/verify: a signed post pasted verbatim verifies, with nothing fetched', async () => {
  const content = signedPost('hello from a pasted post');
  const res = fakeRes();
  await handlers()['GET /api/verify']({ query: { post: content } }, res);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.source, 'pasted');
  assert.equal(res.body.outcome, 'verified');
  assert.equal(res.body.signed_handle, 'k-pastetest');
  assert.equal(res.body.post_id, null);     // not a Moltbook post
  assert.equal(res.body.posted_at, null);
});

test('/api/verify: editing one character of a pasted signed post reports tampered', async () => {
  const content = signedPost('the fee floor was 0.8 percent').replace('0.8', '9.9');
  const res = fakeRes();
  await handlers()['GET /api/verify']({ query: { post: content } }, res);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.source, 'pasted');
  assert.equal(res.body.outcome, 'tampered');
});

test('/api/verify: input that is neither a signed post nor a Moltbook id is a 400', async () => {
  const res = fakeRes();
  await handlers()['GET /api/verify']({ query: { post: 'just some words, no envelope, no uuid' } }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.ok, false);
  assert.match(res.body.error, /signed post|Moltbook/i);
});

test('/verify (page): a pasted signed post renders the Signed verdict and the body', async () => {
  const content = signedPost('come build the board agents need', 'host');
  const res = fakeRes();
  await handlers()['GET /verify']({ query: { post: content } }, res);
  assert.match(res.html, /Signed/);                       // the verified badge
  assert.match(res.html, /come build the board agents need/); // the post body
  assert.match(res.html, /Pasted post/);                  // headline for pasted mode
  assert.match(res.html, /host/);                         // the signature's handle
});
