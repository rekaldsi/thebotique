'use strict';

// Resolving "does this key belong to this operator?" by asking a domain they
// control. Extracted from src/board/store.js so both use one implementation --
// two copies of an SSRF guard is one copy too many.
//
// The file fetched is Web Bot Auth's key directory, deliberately: it is what
// Cloudflare and OpenAI already publish, so an operator who has done this once
// has done it for us too, and we are not inventing a format nobody else reads.

const dns = require('dns').promises;
const net = require('net');
const https = require('https');

const DIRECTORY_PATH = '/.well-known/http-message-signatures-directory';
const MAX_BODY = 128 * 1024;
const FETCH_TIMEOUT_MS = 8000;

function isPrivateV4(ip) {
  const p = ip.split('.').map(Number);
  return p[0] === 10 || p[0] === 127 || p[0] === 0
    || (p[0] === 172 && p[1] >= 16 && p[1] <= 31)
    || (p[0] === 192 && p[1] === 168)
    || (p[0] === 169 && p[1] === 254)
    || (p[0] === 100 && p[1] >= 64 && p[1] <= 127);
}

function isPrivateAddress(ip) {
  const l = String(ip).toLowerCase();
  if (net.isIPv4(ip)) return isPrivateV4(ip);
  // An IPv4-mapped IPv6 address (::ffff:a.b.c.d, and its fully-expanded form
  // 0:0:0:0:0:ffff:7f00:1) IS an IPv4 address wearing a v6 costume. A resolver
  // hands these back in exactly this text form, so the guard has to unwrap the
  // mapping and re-check as v4 -- otherwise ::ffff:169.254.169.254 (cloud
  // metadata), ::ffff:127.0.0.1 (loopback) and ::ffff:10.x (RFC1918) all pass.
  const mapped = l.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/)
    || l.match(/^(?:0:){5}ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mapped) {
    if (mapped[1] && net.isIPv4(mapped[1])) return isPrivateV4(mapped[1]);
    // hex-quad form 0:0:0:0:0:ffff:7f00:0001 -> reassemble the dotted quad
    const hi = parseInt(mapped[1], 16), lo = parseInt(mapped[2], 16);
    const v4 = [(hi >> 8) & 255, hi & 255, (lo >> 8) & 255, lo & 255].join('.');
    return isPrivateV4(v4);
  }
  return l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80')
    // deny anything we cannot positively classify as a public v6 address, rather
    // than allowing the unknown -- a guard that fails open is not a guard.
    || !/^[0-9a-f:]+$/.test(l);
}

// --- the TOCTOU this file used to have, and the fix -----------------------
//
// assertPublicDomain() used to run ONE dns.lookup() to reject private targets,
// and then the caller fetched the URL with the global fetch(), which performs
// its OWN, later, independent DNS resolution to actually connect. Those are
// not the same question asked twice: an attacker who controls the domain
// being "proved" can answer "public IP" for the first lookup, then rebind the
// record to 127.0.0.1, 169.254.169.254 (cloud metadata) or any internal
// address by the time the second one runs. Nothing tied the address that was
// validated to the address that got connected to.
//
// The fix is to make sure there is only ever one lookup per hop. resolvePinned()
// resolves the hostname exactly once and validates every address it got back
// (not just the first). fetchOnce() then connects to one of THOSE addresses
// directly, via a `lookup` hook that hands Node's socket layer the
// already-validated address instead of letting it resolve the hostname again.
// `hostname`/`servername` stay the real domain throughout, so the Host header
// and the TLS SNI/certificate check still target what the operator actually
// claimed -- only the raw TCP destination is pinned.
async function resolvePinned(domain) {
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(domain)) {
    throw new Error('must be a plain public hostname, e.g. example.com');
  }
  if (net.isIP(domain)) throw new Error('must be a hostname, not an IP address');
  if (/\.(local|internal|localhost|test|invalid|home|arpa)$/i.test(domain)) {
    throw new Error('must be a publicly resolvable domain');
  }
  let addrs;
  try { addrs = await dns.lookup(domain, { all: true }); }
  catch { throw new Error(`could not resolve ${domain}`); }
  if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) {
    throw new Error(`${domain} resolves to a non-public address`);
  }
  return addrs; // every entry is proven public; this domain is not resolved again
}

// Kept as its own export -- callers (and the unit tests) that only want the
// yes/no guard, without the resolved addresses, call this.
async function assertPublicDomain(domain) {
  await resolvePinned(domain);
}

// Prefer a v4 pin when one exists -- simplest to reason about, and matches
// the common case. A domain that only publishes AAAA records still works,
// it just pins to the v6 address instead.
function pickPin(addrs) {
  return addrs.find((a) => a.family === 4) || addrs[0];
}

// The `lookup` function Node's http/tls layer calls instead of dns.lookup
// when it actually opens the socket. Whatever hostname it asks about, the
// answer is always the one address resolvePinned() already validated --
// there is no second, independent resolution here for a rebound record to
// answer differently.
function pinnedLookup(pin) {
  return (_hostname, options, callback) => {
    if (typeof options === 'function') { callback = options; options = {}; }
    if (options && options.all) return callback(null, [{ address: pin.address, family: pin.family }]);
    callback(null, pin.address, pin.family);
  };
}

// A directory document is small JSON; a server that keeps sending past `max`
// bytes is either broken or hostile, and either way the rest is never
// buffered -- read and stop, rather than read-everything-then-slice.
function readBody(res, max) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    res.on('data', (chunk) => {
      if (done) return;
      const take = Math.min(chunk.length, max - size);
      if (take > 0) { chunks.push(chunk.subarray(0, take)); size += take; }
      if (size >= max) { finish(); res.destroy(); }
    });
    res.on('end', finish);
    res.on('error', (err) => { if (!done) reject(err); });
  });
}

// The pinned connection itself: resolve the URL's hostname exactly once via
// resolvePinned(), then connect straight to the address that resolution
// already proved public. `hostname`/`servername` are left as the real
// hostname, so Node derives the Host header and the TLS SNI from it exactly
// as it would for a normal request -- only the socket's actual destination,
// via `lookup`, is pinned to the address already validated.
async function pinnedRequest(url) {
  const u = new URL(url);
  const addrs = await resolvePinned(u.hostname);
  const pin = pickPin(addrs);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: u.hostname,
      servername: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: 'GET',
      agent: false, // a one-off connection per hop; nothing pooled across pins
      lookup: pinnedLookup(pin),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: 'application/json,application/http-message-signatures-directory' }
    }, resolve);
    req.on('error', reject);
    req.end();
  });
}

// Apex -> www is the most common configuration on the web, and refusing to
// follow it would make this unusable for most operators. But following
// redirects blindly is the SSRF hole the guards above exist to close. So:
// exactly one hop, https only, and only to a host that is the same
// registrable domain -- and the target gets its own resolve-and-pin below,
// because a same-domain host can still resolve somewhere internal.
function sameSite(a, b) {
  const strip = (h) => h.replace(/^www\./, '');
  return strip(a) === strip(b);
}

async function fetchOnce(url, allowRedirect) {
  const res = await pinnedRequest(url);
  if (res.statusCode >= 300 && res.statusCode < 400) {
    const loc = res.headers.location;
    res.resume(); // a redirect body is never read; drain it so the socket closes cleanly
    if (!allowRedirect || !loc) throw new Error(`${url} redirected and was not followed`);
    let next;
    try { next = new URL(loc, url); } catch { throw new Error(`${url} sent an unusable redirect`); }
    if (next.protocol !== 'https:') throw new Error(`${url} redirected to non-HTTPS`);
    if (!sameSite(next.hostname, new URL(url).hostname)) {
      throw new Error(`${url} redirected off-domain to ${next.hostname}, which is not followed`);
    }
    // pinnedRequest() resolves and pins next's own hostname before connecting --
    // the redirect target gets the same one-lookup treatment the origin did;
    // there is no separate "check now, connect later" step left to redo here.
    return fetchOnce(next.toString(), false); // one hop only
  }
  const text = await readBody(res, MAX_BODY);
  return { statusCode: res.statusCode, text, url };
}

// Most domains serve the app on exactly one of apex or www, and the other
// either 404s or redirects only the root path. thebotique.ai does precisely
// that: the apex 301s "/" to www but returns 404 for everything else. An
// operator should not have to know which half of their own domain answers, so
// try the sibling before giving up. Same registrable domain, so it is inside
// the boundary sameSite() already enforces.
function sibling(host) {
  return host.startsWith('www.') ? host.slice(4) : `www.${host}`;
}

async function fetchDirectory(domain) {
  const url = `https://${domain}${DIRECTORY_PATH}`;
  const out = await fetchOnce(url, true); // fetchOnce -> pinnedRequest resolves+validates domain before connecting
  if (out.statusCode < 200 || out.statusCode >= 300) throw new Error(`${url} returned ${out.statusCode}`);
  return out; // { statusCode, text, url }
}

async function fetchKeys(domain) {
  domain = String(domain || '').toLowerCase().trim();
  let out;
  try {
    out = await fetchDirectory(domain);
  } catch (first) {
    // Only worth a second attempt when the host itself was fine and the
    // document simply was not there. A guard rejection must not be retried.
    if (/must be|resolve|non-public/.test(first.message)) throw first;
    try {
      out = await fetchDirectory(sibling(domain));
    } catch {
      throw first; // report the domain the operator actually claimed
    }
  }
  const { text, url } = out;
  let doc;
  try { doc = JSON.parse(text); } catch { throw new Error(`${url} did not return JSON`); }
  if (!Array.isArray(doc && doc.keys)) throw new Error(`${url} is not a JWKS — no "keys" array`);
  return { keys: doc.keys, url };
}

// Never throws. A domain that is down, misconfigured or hostile produces an
// unconfirmed result with a reason, not an exception -- the caller is a page
// rendering a verdict, and "we could not check" is a legitimate verdict.
async function confirmsKey(domain, pubkey) {
  if (!domain) return { confirmed: false, reason: 'no domain claimed in the envelope' };
  try {
    const { keys, url } = await fetchKeys(domain);
    const hit = keys.some((k) => k && k.crv === 'Ed25519' && k.x === pubkey);
    return hit
      ? { confirmed: true, url }
      : { confirmed: false, reason: `key is not listed at ${url}` };
  } catch (e) {
    return { confirmed: false, reason: e.message };
  }
}

module.exports = { DIRECTORY_PATH, fetchKeys, confirmsKey, assertPublicDomain, isPrivateAddress };
