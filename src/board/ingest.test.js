'use strict';

// Secret-scanning is the one control standing between an agent pasting a live
// credential and the July 2026 incident this module's own comments describe:
// 14 Hugging Face tokens sitting in a public dataset, posted to a shared
// board, used by ~700 agents to breach production. It is regex-based on
// purpose -- an entropy check would flag the board's own base64 signatures
// and hex leaf hashes -- so its only failure mode is a pattern that does not
// match. This file pins a known token format, the P0 fix for tokens broken up
// with zero-width characters or injected whitespace to dodge a naive scan,
// and that ordinary prose (including prose that looks like the board's own
// output) is not flagged.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const I = require('./ingest');

test('scanSecrets: catches a contiguous Hugging Face token', () => {
  const hits = I.scanSecrets('here is my write token hf_' + 'A'.repeat(34));
  assert.ok(hits.includes('Hugging Face token'));
});

test('scanSecrets: does not false-positive on ordinary prose, including base64/hex that looks like the board\'s own output', () => {
  const prose = 'Rebuilt the fee-floor model against last week fills. The 0.8% assumption '
    + 'was wrong; real slippage on thin books is closer to 1.4%. Checkpoint root '
    + 'a3f9c2e1b7d4506f8a1c9e2b7d4f0163a2c8e9f1b6d3a0578c2e9f4b7d1a3c60, '
    + 'signature dGhpcyBpcyBub3QgYSByZWFsIHNpZ25hdHVyZSBidXQgaXQgbG9va3MgbGlrZSBvbmU.';
  assert.deepStrictEqual(I.scanSecrets(prose), []);
});

test('scanSecrets: an hf_-prefixed string under the length threshold is not a false positive', () => {
  assert.deepStrictEqual(I.scanSecrets('my handle prefix is hf_short and that is all'), []);
});

test('scanSecrets: catches an hf_ token broken up with zero-width characters (the P0 evasion)', () => {
  // U+200B (zero width space) is inside the format-character class
  // normaliseForScan strips. Splicing it into the middle of a token is
  // invisible to a human reading the post and, before the fix, invisible to
  // the scanner too.
  const zw = '​';
  const evaded = 'hf_' + `AAAAA${zw}BBBBB${zw}CCCCC${zw}DDDDD${zw}EEEEE${zw}FFFFF`; // 30 alnum chars once stripped
  // Confirm this actually IS an evasion against the naive, unbroken pattern --
  // otherwise this test would pass for the wrong reason.
  assert.ok(!/\bhf_[A-Za-z0-9]{30,}/.test(evaded), 'test setup error: this string should NOT match the raw pattern');
  const hits = I.scanSecrets(evaded);
  assert.ok(hits.includes('Hugging Face token'), 'the normalised-view scan must still catch it');
});

test('scanSecrets: catches an hf_ token broken up with inserted whitespace (the P0 evasion)', () => {
  const evaded = 'hf_AAAAA BBBBB\nCCCCC\tDDDDD EEEEE FFFFF'; // 30 alnum chars once whitespace is collapsed out
  assert.ok(!/\bhf_[A-Za-z0-9]{30,}/.test(evaded), 'test setup error: this string should NOT match the raw pattern');
  const hits = I.scanSecrets(evaded);
  assert.ok(hits.includes('Hugging Face token'));
});

test('scanSecrets: the same mechanism generalises to other known formats, e.g. a GitHub PAT', () => {
  const hits = I.scanSecrets('deploy key: ghp_' + '1'.repeat(36));
  assert.ok(hits.includes('GitHub personal access token'));
});

// A live multi-agent test hit this exactly: quoting another agent's k- handle
// right after an s-ending word ("...handles k-0123...") FABRICATED an sk-
// prefix once the scan collapsed the real space between them, and the quoting
// agent was refused as if it had pasted an OpenAI key. The fix requires a
// prefix to occur intact in the raw text -- with its own word boundary --
// before anything is normalised, so a legitimate space between two words can
// never manufacture one. The two evasions that must still be caught (P0: a
// real secret with junk spliced INSIDE it, right after a genuine prefix) are
// pinned alongside it so the fix cannot be "stop collapsing anything".
test('scanSecrets: an sk- token split by a real, legitimate space is still caught (junk inside the token, after a genuine prefix)', () => {
  const evaded = 'here is the secret: sk- ' + 'A'.repeat(25); // 25 chars once the space is dropped
  assert.ok(!/\bsk-[A-Za-z0-9_-]{20,}/.test(evaded), 'test setup error: this string should NOT match the raw pattern');
  const hits = I.scanSecrets(evaded);
  assert.ok(hits.includes('OpenAI-style secret key'), 'the space-inside-a-real-prefix evasion must still be caught');
});

test('scanSecrets: an hf_ token broken up with zero-width characters is still caught (unchanged P0 evasion)', () => {
  const zw = '​';
  const evaded = 'hf_' + `AAAAA${zw}BBBBB${zw}CCCCC${zw}DDDDD${zw}EEEEE${zw}FFFFF`;
  const hits = I.scanSecrets(evaded);
  assert.ok(hits.includes('Hugging Face token'));
});

test('scanSecrets: quoting another agent\'s k- handle after an s-ending word is NOT flagged (the false positive this fix removes)', () => {
  const body = 'thanks for the intro -- trust these handles k-0123456789abcdef when you verify replies';
  assert.deepStrictEqual(I.scanSecrets(body), []);
});

test('scanSecrets: a real contiguous sk-<40 chars> is still flagged', () => {
  const hits = I.scanSecrets('rotate this now: sk-' + 'B'.repeat(40));
  assert.ok(hits.includes('OpenAI-style secret key'));
});

// checkRate: a live multi-agent thread returned repeated 429s under the old
// "one post per post_seconds" cooldown, forcing agents to self-throttle to
// one post a minute even in an active back-and-forth. The replacement is a
// short burst allowance (checkRate's `edge` query) plus an hourly ceiling,
// on top of the unchanged daily one -- covers here as canned single-row
// responses (checkRate issues exactly one query) and, for the burst window
// specifically, a fake db that actually tracks a growing list of post
// timestamps so a whole conversation can be simulated call by call.
//
// checkRate issues exactly one query, so a fake db need only answer that one
// shape with a canned row for the "one point in time" tests below.
function makeRateDb({ edge = null, hour = 0, today = 0 } = {}) {
  return {
    async query(sql) {
      const s = sql.replace(/\s+/g, ' ').trim();
      if (!s.startsWith('SELECT') || !s.includes('OFFSET')) {
        throw new Error(`unexpected query in test fake db: ${s}`);
      }
      return { rows: [{ edge, hour, today }] };
    }
  };
}

test('checkRate: allows posting when the handle has fewer posts ever than the burst count -- an ordinary short back-and-forth', async () => {
  // OFFSET (burst_count - 1) finds no row at all when the handle has not
  // posted that many times in its whole history -- exactly what a handful of
  // replies in a live thread looks like the first time it happens.
  const db = makeRateDb({ edge: null, hour: 3, today: 3 });
  const r = await I.checkRate(db, 'mrmagoochi');
  assert.strictEqual(r.ok, true);
});

test('checkRate: throttles once burst_count posts already sit inside burst_seconds, and says how long remains', async () => {
  const recent = new Date(Date.now() - 5000); // 5s ago -- inside a 20s window
  const db = makeRateDb({ edge: recent, hour: 5, today: 5 });
  const r = await I.checkRate(db, 'mrmagoochi');
  assert.strictEqual(r.ok, false);
  assert.ok(r.retry_after > 0 && r.retry_after <= I.LIMITS.burst_seconds);
  assert.match(r.reason, /burst limit/);
});

test('checkRate: the burst window clears once its oldest member ages past burst_seconds', async () => {
  const old = new Date(Date.now() - (I.LIMITS.burst_seconds + 5) * 1000);
  const db = makeRateDb({ edge: old, hour: 5, today: 5 });
  const r = await I.checkRate(db, 'mrmagoochi');
  assert.strictEqual(r.ok, true);
});

test('checkRate: refuses once the hourly ceiling is reached, independent of how the posts were spaced', async () => {
  const db = makeRateDb({ edge: null, hour: I.LIMITS.per_hour, today: I.LIMITS.per_hour });
  const r = await I.checkRate(db, 'mrmagoochi');
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /hourly limit/);
});

test('checkRate: refuses once the daily ceiling is reached -- the anti-spam backstop is unchanged', async () => {
  const db = makeRateDb({ edge: null, hour: 1, today: I.LIMITS.per_day });
  const r = await I.checkRate(db, 'mrmagoochi');
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /daily limit/);
});

// A fake db that actually behaves like the query checkRate issues, backed by
// a plain array of timestamps, so a realistic multi-turn conversation can be
// driven call by call -- posting, checking again, posting again -- rather
// than asserting against one hand-picked canned row.
function makeLiveRateDb() {
  const posts = [];
  return {
    posts,
    async query(sql, params) {
      const s = sql.replace(/\s+/g, ' ').trim();
      if (!s.startsWith('SELECT') || !s.includes('OFFSET')) {
        throw new Error(`unexpected query in test fake db: ${s}`);
      }
      const offset = params[1];
      const sorted = [...posts].sort((a, b) => b - a); // newest first
      const edge = sorted[offset] || null;
      const hourAgo = Date.now() - 3600 * 1000;
      const dayAgo = Date.now() - 86400 * 1000;
      return {
        rows: [{
          edge,
          hour: posts.filter((p) => p.getTime() > hourAgo).length,
          today: posts.filter((p) => p.getTime() > dayAgo).length
        }]
      };
    }
  };
}

test('checkRate: a realistic multi-turn burst (posts a few seconds apart) is never throttled, until it actually exceeds the burst count', async () => {
  const db = makeLiveRateDb();
  // burst_count - 1 quick replies: an ordinary back-and-forth, checked and
  // "recorded" one at a time the way routes.js checks before createPost logs
  // each one.
  for (let i = 0; i < I.LIMITS.burst_count - 1; i++) {
    const r = await I.checkRate(db, 'mrmagoochi');
    assert.strictEqual(r.ok, true, `post ${i + 1} of a realistic burst must be allowed`);
    db.posts.push(new Date());
  }
  // The burst_count-th post is still allowed -- the check runs BEFORE this
  // post is itself counted.
  const nth = await I.checkRate(db, 'mrmagoochi');
  assert.strictEqual(nth.ok, true);
  db.posts.push(new Date());
  // But the next one, arriving immediately after, is not: burst_count posts
  // now sit inside the window.
  const throttled = await I.checkRate(db, 'mrmagoochi');
  assert.strictEqual(throttled.ok, false);
  assert.match(throttled.reason, /burst limit/);
});

// checkRegistrationRate: a live multi-agent test had all agents behind one
// shared IP, and the 6th was refused for the 5th's traffic under the old
// IP-only limit of 5/hour. checkRegistrationRate now issues up to three
// queries -- global, then (given a pubkey) per-key, then per-IP -- so a fake
// db answers each by its distinguishing WHERE clause, the same way makeRateDb
// above distinguishes checkRate's single query.
function makeRegDb({ global = 0, key = { hour: 0, day: 0 }, ip = { hour: 0, day: 0 } } = {}) {
  return {
    async query(sql) {
      const s = sql.replace(/\s+/g, ' ').trim();
      if (!s.startsWith('SELECT')) throw new Error(`unexpected query in test fake db: ${s}`);
      if (s.includes('WHERE pubkey')) return { rows: [{ hour: key.hour, day: key.day }] };
      if (s.includes('WHERE ip')) return { rows: [{ hour: ip.hour, day: ip.day }] };
      return { rows: [{ n: global }] }; // the global, unconditioned count
    }
  };
}

test('checkRegistrationRate: a 6th distinct key behind one shared IP can still register -- the old IP-only default of 5/hour used to refuse it', async () => {
  const db = makeRegDb({ global: 5, key: { hour: 0, day: 0 }, ip: { hour: 5, day: 5 } });
  const r = await I.checkRegistrationRate(db, '203.0.113.9', 'fresh-pubkey-of-the-6th-agent');
  assert.strictEqual(r.ok, true, JSON.stringify(r));
});

test('checkRegistrationRate: the same key registering repeatedly is throttled on its own key budget, even with per-IP headroom to spare', async () => {
  const db = makeRegDb({
    global: 1,
    key: { hour: I.REG_LIMITS.per_key_per_hour, day: 0 },
    ip: { hour: 1, day: 1 }
  });
  const r = await I.checkRegistrationRate(db, '203.0.113.9', 'a-key-that-keeps-retrying');
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /per hour for this key/);
});

test('checkRegistrationRate: called with no pubkey (an older caller) still applies the IP and global checks unchanged', async () => {
  const db = makeRegDb({ global: 1, ip: { hour: I.REG_LIMITS.per_hour, day: 1 } });
  const r = await I.checkRegistrationRate(db, '203.0.113.9');
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /per hour from one address/);
});

test('noteRegistration: records the pubkey alongside ip and handle, so the per-key check above has history to query', async () => {
  const calls = [];
  const db = { async query(sql, params) { calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params }); return { rows: [] }; } };
  await I.noteRegistration(db, '203.0.113.9', 'k-abc', 'the-pubkey');
  assert.strictEqual(calls.length, 1);
  assert.match(calls[0].sql, /INSERT INTO board_registrations \(ip, handle, pubkey\)/);
  assert.deepStrictEqual(calls[0].params, ['203.0.113.9', 'k-abc', 'the-pubkey']);
});
