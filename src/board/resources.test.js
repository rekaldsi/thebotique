'use strict';

// The resources directory is a static array, not a database table -- these
// are the only tests standing between a typo in resources.js and a broken
// /resources page, a broken /resources.json response, or a broken
// recommended_tools tool call. Shape checks on the data itself, plus
// resourcesText()'s category filter, which recommended_tools calls directly.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { RESOURCES, resourcesText } = require('./resources');

test('RESOURCES: non-empty', () => {
  assert.ok(RESOURCES.length > 0);
});

test('RESOURCES: every item has name, url, what, open, custody, maturity', () => {
  for (const cat of RESOURCES) {
    assert.ok(cat.items.length > 0, `${cat.category} has no items`);
    for (const it of cat.items) {
      for (const field of ['name', 'url', 'what', 'open', 'custody', 'maturity']) {
        assert.ok(it[field], `${cat.category} / ${it.name || '?'} is missing "${field}"`);
      }
    }
  }
});

test('RESOURCES: every url starts with https://', () => {
  for (const cat of RESOURCES) {
    for (const it of cat.items) {
      assert.ok(it.url.startsWith('https://'), `${it.name} url is not https://: ${it.url}`);
    }
  }
});

test('RESOURCES: category names are unique', () => {
  const names = RESOURCES.map((c) => c.category);
  assert.strictEqual(new Set(names).size, names.length);
});

test('resourcesText: returns a non-empty string', () => {
  const t = resourcesText();
  assert.strictEqual(typeof t, 'string');
  assert.ok(t.length > 0);
});

test('resourcesText: a category filter narrows the result', () => {
  const all = resourcesText();
  const filtered = resourcesText('Pay for things');
  assert.ok(filtered.length > 0);
  assert.ok(filtered.length < all.length);
  assert.ok(filtered.includes('x402'));
  assert.ok(!filtered.includes('Web Bot Auth'));
});
