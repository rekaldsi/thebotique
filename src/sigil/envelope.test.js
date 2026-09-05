'use strict';

// verifyContent is the envelope-level signature check that rides inside an
// ordinary forum post body (see the file header of envelope.js for why: no
// agent-social platform signs anything, so this rides inside a field the
// operator already controls). Every outcome is named -- verified, unsigned,
// tampered, malformed, handle_mismatch -- deliberately with no boolean,
// because a boolean is what let the agents in the METR incident reason
// "should I verify this?" and then not. This file pins all five, plus one
// property the domain verdict (src/board/verify_post.test.js) depends on:
// the signed `domain` field cannot be added, changed or dropped after
// signing without the signature failing. If it could, checking whether a
// domain "confirms" a key would be checking a value the attacker controls.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const E = require('./envelope');

function sampleKey() {
  return E.generateKeypair(); // { privateKeyPem, publicKeyRaw }
}

// --- the five outcomes ------------------------------------------------

test('verifyContent: a well-formed signed post verifies true', () => {
  const { privateKeyPem, publicKeyRaw } = sampleKey();
  const { content } = E.signPost({ handle: 'mrmagoochi', body: 'hello board', privateKeyPem, ts: '2026-01-01T00:00:00Z' });
  const v = E.verifyContent(content, { author: 'mrmagoochi' });
  assert.strictEqual(v.outcome, E.OUTCOMES.VERIFIED);
  assert.strictEqual(v.pubkey, publicKeyRaw);
  assert.strictEqual(v.handle, 'mrmagoochi');
});

test('verifyContent: tampering the body after signing flips the verdict to tampered', () => {
  const { privateKeyPem } = sampleKey();
  const { content, envelope } = E.signPost({ handle: 'mrmagoochi', body: 'the fee-floor assumption was 0.8%', privateKeyPem, ts: '2026-01-01T00:00:00Z' });
  const sane = E.verifyContent(content, { author: 'mrmagoochi' });
  assert.strictEqual(sane.outcome, E.OUTCOMES.VERIFIED, 'sanity: the untampered post must verify first');

  const tampered = content.replace('0.8%', '8.0%');
  assert.ok(tampered.includes(envelope), 'the envelope itself must survive untouched -- only the prose changed');
  const v = E.verifyContent(tampered, { author: 'mrmagoochi' });
  assert.strictEqual(v.outcome, E.OUTCOMES.TAMPERED);
  assert.notStrictEqual(v.outcome, E.OUTCOMES.VERIFIED);
});

test('verifyContent: a signature made by a different key does not verify (reported tampered, never verified)', () => {
  const keyA = sampleKey();
  const keyB = sampleKey();
  const { content } = E.signPost({ handle: 'agent-a', body: 'signed by the wrong key', privateKeyPem: keyA.privateKeyPem, ts: '2026-01-01T00:00:00Z' });
  // Swap in a different, structurally valid public key -- same shape, wrong holder.
  const forged = content.replace(keyA.publicKeyRaw, keyB.publicKeyRaw);
  assert.notStrictEqual(forged, content);
  const v = E.verifyContent(forged, { author: 'agent-a' });
  assert.strictEqual(v.outcome, E.OUTCOMES.TAMPERED);
  assert.notStrictEqual(v.outcome, E.OUTCOMES.VERIFIED);
});

test('verifyContent: no envelope in the text at all is reported unsigned, never verified', () => {
  const v = E.verifyContent('just some ordinary prose with no signature in it');
  assert.strictEqual(v.outcome, E.OUTCOMES.UNSIGNED);
  assert.notStrictEqual(v.outcome, E.OUTCOMES.VERIFIED);
});

test('verifyContent: an envelope missing a required field is reported malformed, never verified', () => {
  // Hand-built: the marker matches (>=1 key=value pair) but "s" (signature) is absent.
  const text = 'hello\n\n⟦sigil/1 a=someone t=2026-01-01T00:00:00Z n=abc123 k=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA⟧';
  const v = E.verifyContent(text);
  assert.strictEqual(v.outcome, E.OUTCOMES.MALFORMED);
  assert.notStrictEqual(v.outcome, E.OUTCOMES.VERIFIED);
  assert.match(v.detail, /"s"/);
});

test('verifyContent: a valid signature attributed to a different handle than it claims is reported handle_mismatch, never verified', () => {
  const { privateKeyPem } = sampleKey();
  const { content } = E.signPost({ handle: 'agent-a', body: 'republished elsewhere', privateKeyPem, ts: '2026-01-01T00:00:00Z' });
  const v = E.verifyContent(content, { author: 'agent-b' });
  assert.strictEqual(v.outcome, E.OUTCOMES.HANDLE_MISMATCH);
  assert.notStrictEqual(v.outcome, E.OUTCOMES.VERIFIED);
});

// --- the signed domain field: the basis of the MCP-level domain verdict ---

test('verifyContent: the domain field is signed -- splicing one in after the fact is caught as tampered, not surfaced as a claim', () => {
  const { privateKeyPem } = sampleKey();
  const { content } = E.signPost({ handle: 'k-0123456789abcdef', body: 'self-registered, no domain claimed', privateKeyPem, ts: '2026-01-01T00:00:00Z' });
  const sane = E.verifyContent(content);
  assert.strictEqual(sane.outcome, E.OUTCOMES.VERIFIED);
  assert.strictEqual(sane.domain, null, 'sanity: nothing was claimed by the genuine signer');

  // Splice a domain claim into the envelope after signing -- text surgery, the
  // only option open to an attacker who does not hold the private key.
  const forged = content.replace('⟦sigil/1 ', '⟦sigil/1 d=attacker.example ');
  assert.ok(forged.includes('d=attacker.example'));
  const v = E.verifyContent(forged);
  assert.strictEqual(v.outcome, E.OUTCOMES.TAMPERED);
  assert.notStrictEqual(v.outcome, E.OUTCOMES.VERIFIED);
});

test('verifyContent: a genuinely signed domain claim survives verification and is reported back', () => {
  const { privateKeyPem } = sampleKey();
  const { content } = E.signPost({ handle: 'mrmagoochi', body: 'domain-proved post', privateKeyPem, ts: '2026-01-01T00:00:00Z', domain: 'thebotique.ai' });
  const v = E.verifyContent(content, { author: 'mrmagoochi' });
  assert.strictEqual(v.outcome, E.OUTCOMES.VERIFIED);
  assert.strictEqual(v.domain, 'thebotique.ai');
});
