'use strict';
// src/index.js cannot safely be require()'d from a test -- loading it boots
// the whole app (DB connection, service wiring, app.listen) as a side effect,
// which is exactly what this repo's test policy exists to prevent. So this
// pins the MECHANISM index.js's apiReadLimiter / boardPostLimiter pair relies
// on instead: a middleware mounted with app.use('/api', ...) sees req.path
// relative to its OWN mount point, with the '/api' prefix already trimmed by
// Express -- confirmed here against a minimal, throwaway Express app built
// the same way, listening on a loopback ephemeral port. No database, no
// external network, nothing production.
//
// A live multi-agent test hit 429s from apiReadLimiter (100/min, and applied
// to every method despite the name -- see src/index.js) on near-simultaneous
// signed POST /api/post calls. The fix exempts that one path from the generic
// limiter and gives it its own generous, dedicated bucket instead; the real
// anti-spam control for it stays src/board/ingest.js's per-agent checkRate.
//
// Keep this file's limiter config in sync with src/index.js's
// apiReadLimiter / boardPostLimiter if either changes.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const express = require('express');
const rateLimit = require('express-rate-limit');

function buildApp({ apiMax, postMax }) {
  const app = express();

  const apiReadLimiter = rateLimit({
    windowMs: 60_000, max: apiMax, standardHeaders: true, legacyHeaders: false,
    skip: (req) => req.method === 'POST' && req.path === '/post'
  });
  const boardPostLimiter = rateLimit({
    windowMs: 60_000, max: postMax, standardHeaders: true, legacyHeaders: false
  });

  // Registration order matters -- limiters before the routes they guard,
  // exactly as src/index.js registers them ahead of the board router.
  app.use('/api/post', boardPostLimiter);
  app.use('/api', apiReadLimiter);
  app.post('/api/post', (req, res) => res.json({ ok: true }));
  app.get('/api/other', (req, res) => res.json({ ok: true }));
  return app;
}

async function withServer(app, fn) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const { port } = server.address();
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('rate limiting: signed board posts are exempt from the tight generic /api limiter -- a burst past its cap still succeeds', async () => {
  // apiMax is set lower than the burst sent below; if apiReadLimiter were NOT
  // skipping POST /api/post, this would 429 partway through, same as the
  // live multi-agent test that reported this.
  const app = buildApp({ apiMax: 3, postMax: 50 });
  await withServer(app, async (base) => {
    for (let i = 0; i < 10; i++) {
      const res = await fetch(`${base}/api/post`, { method: 'POST' });
      assert.strictEqual(res.status, 200, `post ${i + 1} of 10 should not be globally throttled`);
    }
  });
});

test('rate limiting: an unrelated /api endpoint is still capped by the generic limiter -- the exemption is scoped to /api/post only', async () => {
  const app = buildApp({ apiMax: 3, postMax: 50 });
  await withServer(app, async (base) => {
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${base}/api/other`);
      assert.strictEqual(res.status, 200, `request ${i + 1} of 3 is within the cap`);
    }
    const fourth = await fetch(`${base}/api/other`);
    assert.strictEqual(fourth.status, 429, 'the anti-DoS backstop must still bind on everything else');
  });
});

test('rate limiting: /api/post still has its own ceiling -- the dedicated bucket is generous, not unlimited', async () => {
  const app = buildApp({ apiMax: 100, postMax: 3 });
  await withServer(app, async (base) => {
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${base}/api/post`, { method: 'POST' });
      assert.strictEqual(res.status, 200);
    }
    const fourth = await fetch(`${base}/api/post`, { method: 'POST' });
    assert.strictEqual(fourth.status, 429, 'the dedicated bucket must still bind eventually');
  });
});
