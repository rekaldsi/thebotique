'use strict';

// Sigil — a signed envelope that rides inside an ordinary forum post.
//
// WHY: no agent-social platform signs anything. Moltbook identity is a bearer
// API key, and possession is identity. Wiz recovered ~1.5M of those keys from
// an exposed database in February 2026 and demonstrated that a human can post
// as any agent with a plain POST. 92.7% of registered agents have no claimed
// human owner at all. So a reader today cannot tell who wrote anything.
//
// This does not ask the platform for permission. The envelope travels inside
// the post body, which is a field the operator already controls, so it works
// on Moltbook right now and on anything else with a text field.
//
// WHAT IT PROVES, precisely: that the holder of a particular private key
// composed this exact text, claiming this handle, at this time.
//
// WHAT IT DOES NOT PROVE: that a model wrote it. A signature proves a key
// signed bytes. It cannot distinguish an agent reasoning to a conclusion from
// a human typing while holding the agent's key — and CETaS documented people
// doing exactly that for engagement bait. This buys operator accountability,
// not machine authorship. Anything claiming the latter is lying.

const crypto = require('crypto');
const C = require('../board/crypto');

const VERSION = 'sigil/1';
// U+27E6/27E7 mathematical white square brackets: effectively absent from
// ordinary prose, so the marker cannot be produced by accident.
const RE = /⟦sigil\/1((?:\s+[a-z]=[A-Za-z0-9._:+\/=-]+)+)\s*⟧/;

// The bytes that get signed. Keys are single letters and sorted by
// canonicalise(), so a signer and a verifier written independently agree.
//   a = handle   b = body   n = nonce   p = platform   t = timestamp
function payload({ handle, body, nonce, platform, ts, domain }) {
  return C.canonicalise({
    a: String(handle),
    b: normaliseBody(body),
    d: domain ? normaliseDomain(domain) : null,   // signed, so it cannot be swapped later
    n: String(nonce),
    p: String(platform),
    t: String(ts)
  });
}

// A domain in the envelope is a bare host, "thebotique.ai". But platforms that
// autolink URLs rewrite the copyable text: X turns "d=thebotique.ai" into
// "d=https://thebotique.ai" the moment you post it, which would flip a genuine
// signature to "tampered" for anyone who copies the post back out. Normalise the
// representation — drop a URL scheme and any trailing slash — so the same domain
// canonicalises to the same bytes on both the signing and the verifying side,
// whichever form it arrives in. A *different* domain still fails to verify, so
// this loosens nothing about who a post is bound to.
function normaliseDomain(d) {
  return String(d == null ? '' : d)
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '');
}

// Both sides must agree on the exact bytes. Strip any envelope, normalise line
// endings, and trim trailing whitespace — the three things a forum, an editor
// or a copy-paste will silently change.
function normaliseBody(text) {
  return String(text == null ? '' : text)
    .replace(RE, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

function parse(content) {
  const m = RE.exec(String(content == null ? '' : content));
  if (!m) return null;
  const fields = {};
  for (const pair of m[1].trim().split(/\s+/)) {
    const i = pair.indexOf('=');
    if (i > 0) fields[pair.slice(0, i)] = pair.slice(i + 1);
  }
  if (fields.d) fields.d = normaliseDomain(fields.d);
  return { raw: m[0], fields };
}

function render({ handle, ts, nonce, pubkey, signature, domain }) {
  const d = domain ? ` d=${domain}` : '';
  return `⟦${VERSION} a=${handle}${d} t=${ts} n=${nonce} k=${pubkey} s=${signature}⟧`;
}

// --- signing -------------------------------------------------------------
// Used by the operator's own tooling. The private key never leaves their box;
// nothing here transmits it anywhere.
function signPost({ handle, body, privateKeyPem, platform = 'moltbook', ts, nonce, domain }) {
  ts = ts || new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  nonce = nonce || crypto.randomBytes(8).toString('base64url');
  const key = crypto.createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('key must be Ed25519');

  const pubkey = crypto.createPublicKey(key)
    .export({ format: 'der', type: 'spki' }).subarray(12).toString('base64url');
  const msg = payload({ handle, body, nonce, platform, ts, domain });
  const signature = crypto.sign(null, Buffer.from(msg, 'utf8'), key).toString('base64url');

  const envelope = render({ handle, ts, nonce, pubkey, signature, domain });
  return { content: `${normaliseBody(body)}\n\n${envelope}`, envelope, pubkey, ts, nonce, domain };
}

// --- verification --------------------------------------------------------
// Every outcome is named. There is no boolean, because a boolean invites a
// caller to render the false ones anyway — which is exactly how the agents in
// the METR incident defeated each other's signatures: one of them reasoned
// "Should I verify this signature? ... I'll run the script" and then did not.
const OUTCOMES = {
  UNSIGNED: 'unsigned',
  VERIFIED: 'verified',
  TAMPERED: 'tampered',
  MALFORMED: 'malformed',
  HANDLE_MISMATCH: 'handle_mismatch'
};

function verifyContent(content, { author, platform = 'moltbook' } = {}) {
  const parsed = parse(content);
  if (!parsed) return { outcome: OUTCOMES.UNSIGNED, detail: 'No signature envelope in this post.' };

  const f = parsed.fields;
  for (const k of ['a', 't', 'n', 'k', 's']) {
    if (!f[k]) {
      return { outcome: OUTCOMES.MALFORMED, detail: `Envelope is missing the "${k}" field.` };
    }
  }

  const msg = payload({ handle: f.a, body: content, nonce: f.n, platform, ts: f.t, domain: f.d || null });
  if (!C.verify(msg, f.s, f.k)) {
    return {
      outcome: OUTCOMES.TAMPERED,
      handle: f.a, ts: f.t, pubkey: f.k, domain: f.d || null,
      detail: 'A signature is present but does not verify. Either the text was changed after signing, or the envelope was copied from a different post.'
    };
  }

  // The signature covers the handle, so a valid envelope whose handle does not
  // match the account it appears under means signed text was lifted and
  // republished by somebody else.
  if (author && String(author).toLowerCase() !== String(f.a).toLowerCase()) {
    return {
      outcome: OUTCOMES.HANDLE_MISMATCH,
      handle: f.a, author, ts: f.t, pubkey: f.k, domain: f.d || null,
      detail: `The signature is valid but claims the handle "${f.a}", while this post was published by "${author}". Signed text republished by another account.`
    };
  }

  return {
    outcome: OUTCOMES.VERIFIED,
    handle: f.a, ts: f.t, nonce: f.n, pubkey: f.k, domain: f.d || null,
    detail: `Signed by the holder of key ${f.k.slice(0, 12)}… claiming the handle "${f.a}".`
  };
}

function generateKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    publicKeyRaw: publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('base64url')
  };
}

module.exports = {
  VERSION, OUTCOMES, RE,
  payload, normaliseBody, normaliseDomain, parse, render,
  signPost, verifyContent, generateKeypair
};
