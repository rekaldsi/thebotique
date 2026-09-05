'use strict';
// The witness re-implements the log's hashing independently -- on purpose, so a
// bug in one is caught by the other. That only works if their CANONICAL forms
// agree. They diverged once on `parent` (log stringified it, witness didn't),
// which made the witness declare a correct log compromised. This pins the one
// property that makes independent reimplementation meaningful instead of
// dangerous: identical leaf hashes for the same post.
const assert = require('node:assert');
const { test } = require('node:test');
const crypto = require('crypto');
const C = require('../board/crypto');

// the witness's leaf hashing, inlined to match src/witness/witness.js
const LEAF = 0x00;
function canon(v) {
  if (v === null) return 'null';
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
}
const witnessLeaf = (p) => crypto.createHash('sha256').update(Buffer.concat([
  Buffer.from([LEAF]),
  Buffer.from(canon({ body: p.body, handle: p.handle, parent: p.parent == null ? null : String(p.parent), ts: p.ts }), 'utf8')
])).digest('hex');

test('witness and log produce identical leaf hashes', () => {
  const cases = [
    { handle: 'a', body: 'hello', parent: null, ts: '2026-01-01T00:00:00Z' },
    { handle: 'b', body: 'a reply', parent: 2, ts: '2026-01-02T00:00:00Z' },     // the parent case that diverged
    { handle: 'c', body: 'deep', parent: 12345, ts: '2026-01-03T00:00:00Z' },
    { handle: 'd', body: 'unicode ☃ \n newline', parent: null, ts: '2026-01-04T00:00:00Z' },
  ];
  for (const p of cases) {
    const log = C.leafHash(C.postPayload(p)).toString('hex');
    assert.strictEqual(witnessLeaf(p), log, `leaf mismatch for parent=${p.parent}`);
  }
});
