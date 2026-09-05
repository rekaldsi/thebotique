'use strict';

// The key directory: which public keys legitimately belong to agents operating
// under this domain.
//
// This is the file that makes a signature mean something. Anyone can generate
// a key and sign as "mrmagoochi" -- that verifies, just under a different key.
// Publishing the real key here is what lets a verifier say "and this key is
// the one thebotique.ai vouches for."
//
// Format is Web Bot Auth's key directory. Chosen because chatgpt.com already
// serves one at this exact path, so it is a format that already has readers.
//
// The `kid` MUST be the RFC 7638 JWK thumbprint -- SHA-256 over the canonical
// JSON of exactly {crv, kty, x} with members in lexicographic order, base64url
// encoded. This was checked against what chatgpt.com actually serves rather
// than taken from the draft: computing the thumbprint of their published key
// reproduces their published kid exactly.
//
// It used to be the handle here, which is not conformant, and worse, sigil.js
// printed the same shape for every operator to publish. Telling people they
// were publishing "the same file Cloudflare and OpenAI serve" while publishing
// something else was the kind of claim this project exists to be sceptical of.
//
// PUBLIC KEYS ONLY. There is no circumstance in which a private key belongs in
// this file, this module, or this repository. The private halves live at
// ~/.sigil/key.pem on the operator's own machine, mode 600, and the signing
// tool has no network code at all so they cannot leave by accident.

const crypto = require('crypto');
const { SITE } = require('./wire');

// RFC 7638. Only crv, kty and x are members of an OKP thumbprint, and they are
// serialised in lexicographic order with no whitespace.
function thumbprint(jwk) {
  return crypto.createHash('sha256')
    .update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x }))
    .digest('base64url');
}

const KEYS = [
  { kty: 'OKP', crv: 'Ed25519', x: 'ngVrNxhqE5qkzJwhJn9bOl0xSeG7SLEeta2KHKMtOIo' }
];

// A directory whose keys have expired stops verifying, silently, for everyone.
// Publishing a fixed exp would mean this file quietly breaks on a date nobody
// is watching, so the validity window is computed per request and the key is
// asserted valid now rather than until some forgotten timestamp. When key
// rotation exists this becomes a real per-key value.
function withMetadata(k) {
  const now = Math.floor(Date.now() / 1000);
  return {
    kty: k.kty, crv: k.crv, x: k.x,
    kid: k.kid || thumbprint(k),
    use: 'sig',
    nbf: k.nbf || now - 86400,
    exp: k.exp || now + 31536000
  };
}

// Additional keys without a redeploy: SIGIL_KEYS as a JSON array of JWKs.
// Malformed input is ignored rather than thrown, because a typo in an env var
// should not take the site down -- but it is logged so it is not silent.
function extraKeys() {
  if (!process.env.SIGIL_KEYS) return [];
  try {
    const parsed = JSON.parse(process.env.SIGIL_KEYS);
    if (!Array.isArray(parsed)) throw new Error('SIGIL_KEYS must be a JSON array');
    return parsed.filter((k) => k && k.kty === 'OKP' && k.crv === 'Ed25519' && typeof k.x === 'string');
  } catch (e) {
    console.warn('SIGIL_KEYS ignored:', e.message);
    return [];
  }
}

// Proof of domain control for the official MCP registry, which reads this to
// confirm that whoever publishes under the ai.thebotique namespace actually
// controls thebotique.ai. The value is a PUBLIC key and is meant to be read by
// anyone; the private half lives outside this repository and is only ever used
// locally to sign a publish request.
//
// Served on the apex as well as www, because the registry asks the apex and a
// redirect reads as "no proof".
const MCP_REGISTRY_PROOF = process.env.MCP_REGISTRY_PROOF
  || 'v=MCPv1; k=ed25519; p=twqwVnklik2Qtz4yeGGvqgMZ6Kvtu21kf1LwERYzXhg=';

function mount(router) {
  router.get('/.well-known/mcp-registry-auth', (req, res) => {
    res.type('text/plain; charset=utf-8')
      .set('cache-control', 'public, max-age=300')
      .send(MCP_REGISTRY_PROOF + '\n');
  });

  router.get('/.well-known/http-message-signatures-directory', (req, res) => {
    const keys = [...KEYS, ...extraKeys()].map(withMetadata);
    res
      .type('application/http-message-signatures-directory+json')
      .set('cache-control', 'public, max-age=3600')
      .send(JSON.stringify({
        keys,
        // Both are what chatgpt.com publishes alongside its keys, and both say
        // something a verifier can act on: which origin these keys speak for,
        // and that the traffic is an agent rather than a person.
        signature_agent: SITE,
        purpose: 'ai'
      }));
  });
  return router;
}

module.exports = { mount, KEYS, thumbprint, withMetadata };
