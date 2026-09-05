'use strict';
// The bug this pins: assertPublicDomain() used to run ONE dns.lookup() to
// reject private targets, and the caller's fetch() then performed a SECOND,
// independent DNS resolution to actually connect -- a DNS-rebinding TOCTOU an
// attacker who controls the domain being "proved" could win by answering
// "public" for the first lookup and rebinding the record to 127.0.0.1,
// 169.254.169.254 (cloud metadata) or any internal address before the second
// one ran. The fix resolves a hostname exactly once and pins the connection
// to one of the addresses that single resolution already validated, so there
// is no later, independent lookup left for a rebound record to answer
// differently.
//
// What's covered here is the guard the fix depends on: isPrivateAddress
// (including the IPv4-mapped-IPv6 half fixed earlier -- this re-confirms it
// still holds) and assertPublicDomain's use of it against a stubbed resolver,
// for every address in a multi-address answer, not just the first. The
// pinned-connection behaviour itself (resolve once, connect to that address,
// keep Host/SNI on the real hostname) is exercised live against a real
// directory (chatgpt.com) rather than mocked here, since pinning a fake
// resolver to a fake socket wouldn't prove anything about the real one.
const assert = require('node:assert');
const { test } = require('node:test');
const dnsPromises = require('dns').promises;
const D = require('./directory');

test('isPrivateAddress: IPv4-mapped IPv6 is unwrapped and checked as v4', () => {
  // dotted-quad mapped form, exactly as a resolver hands it back
  assert.strictEqual(D.isPrivateAddress('::ffff:169.254.169.254'), true, 'mapped cloud metadata address');
  assert.strictEqual(D.isPrivateAddress('::ffff:127.0.0.1'), true, 'mapped loopback');
  assert.strictEqual(D.isPrivateAddress('::ffff:10.1.2.3'), true, 'mapped RFC1918 10.x');
  assert.strictEqual(D.isPrivateAddress('::ffff:192.168.1.1'), true, 'mapped RFC1918 192.168.x');
  // fully-expanded hex-quad form of the same addresses
  assert.strictEqual(D.isPrivateAddress('0:0:0:0:0:ffff:7f00:1'), true, 'expanded mapped 127.0.0.1');
  assert.strictEqual(D.isPrivateAddress('0:0:0:0:0:ffff:a9fe:a9fe'), true, 'expanded mapped 169.254.169.254');
  // a mapped PUBLIC v4 address must still be allowed through
  assert.strictEqual(D.isPrivateAddress('::ffff:8.8.8.8'), false, 'a mapped public v4 address is not private');
});

test('isPrivateAddress: plain v6 loopback/link-local/ULA, and unclassifiable, are blocked', () => {
  assert.strictEqual(D.isPrivateAddress('::1'), true, 'v6 loopback');
  assert.strictEqual(D.isPrivateAddress('::'), true, 'unspecified address');
  assert.strictEqual(D.isPrivateAddress('fe80::1'), true, 'link-local');
  assert.strictEqual(D.isPrivateAddress('fd00::1'), true, 'unique local (fd)');
  assert.strictEqual(D.isPrivateAddress('fc00::1'), true, 'unique local (fc)');
  assert.strictEqual(D.isPrivateAddress('not-an-address'), true, 'garbage denies rather than fails open');
});

test('isPrivateAddress: real public v4 and v6 addresses are allowed', () => {
  assert.strictEqual(D.isPrivateAddress('8.8.8.8'), false);
  assert.strictEqual(D.isPrivateAddress('1.1.1.1'), false);
  assert.strictEqual(D.isPrivateAddress('2606:4700:4700::1111'), false, 'a real public v6 address');
});

test('isPrivateAddress: plain (non-mapped) private v4 ranges are blocked', () => {
  assert.strictEqual(D.isPrivateAddress('10.0.0.1'), true);
  assert.strictEqual(D.isPrivateAddress('172.16.0.1'), true);
  assert.strictEqual(D.isPrivateAddress('192.168.1.1'), true);
  assert.strictEqual(D.isPrivateAddress('169.254.169.254'), true, 'cloud metadata, unmapped');
  assert.strictEqual(D.isPrivateAddress('127.0.0.1'), true);
});

test('assertPublicDomain: a domain resolving to a private address is rejected', async (t) => {
  t.mock.method(dnsPromises, 'lookup', async () => [{ address: '169.254.169.254', family: 4 }]);
  await assert.rejects(
    D.assertPublicDomain('attacker-controlled.example.com'),
    /non-public/,
    'must reject a private resolution'
  );
});

test('assertPublicDomain: rejects if ANY resolved address is private, not just the first', async (t) => {
  t.mock.method(dnsPromises, 'lookup', async () => [
    { address: '8.8.8.8', family: 4 },   // first entry looks fine on its own
    { address: '127.0.0.1', family: 4 }  // second entry is not -- the whole answer is untrusted
  ]);
  await assert.rejects(D.assertPublicDomain('multi-a-record.example.com'), /non-public/);
});

test('assertPublicDomain: the rejection does not need to name the private address', async (t) => {
  t.mock.method(dnsPromises, 'lookup', async () => [{ address: '169.254.169.254', family: 4 }]);
  await assert.rejects(D.assertPublicDomain('attacker-controlled.example.com'), (err) => {
    assert.ok(!err.message.includes('169.254.169.254'), `error leaked the address: ${err.message}`);
    return true;
  });
});

test('assertPublicDomain: a domain resolving only to public addresses is not rejected', async (t) => {
  t.mock.method(dnsPromises, 'lookup', async () => [{ address: '8.8.8.8', family: 4 }]);
  await assert.doesNotReject(D.assertPublicDomain('a-real-looking-domain.example.com'));
});

test('assertPublicDomain: an empty resolution is rejected', async (t) => {
  t.mock.method(dnsPromises, 'lookup', async () => []);
  await assert.rejects(D.assertPublicDomain('no-records.example.com'), /non-public/);
});

test('assertPublicDomain: an IP literal is rejected before any DNS lookup happens', async () => {
  await assert.rejects(D.assertPublicDomain('127.0.0.1'), /must be a hostname/, 'v4 literal');
  // A v6 literal doesn't even match the hostname-shape check first (no colons
  // allowed there), so it's caught one guard earlier with a different
  // message -- still a rejection, which is what actually matters here.
  await assert.rejects(D.assertPublicDomain('::1'), /must be a plain public hostname/, 'v6 literal');
});

test('assertPublicDomain: reserved-looking TLDs are rejected before any DNS lookup happens', async () => {
  await assert.rejects(D.assertPublicDomain('router.local'), /publicly resolvable/);
  await assert.rejects(D.assertPublicDomain('service.internal'), /publicly resolvable/);
});
