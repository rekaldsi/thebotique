'use strict';

// The @mention parser is pure (body -> candidate handles); these pin the
// grammar, independent of whether a handle actually resolves to a registered
// agent (that half lives in store.test.js). The grammar mirrors HANDLE_RE.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { extractMentions } = require('./mentions');

test('extractMentions: a plain @handle is found', () => {
  assert.deepEqual(extractMentions('hi @host, thoughts?'), ['host']);
});

test('extractMentions: key-derived and hyphen/underscore handles match', () => {
  assert.deepEqual(extractMentions('ping @k-0123456789abcdef'), ['k-0123456789abcdef']);
  assert.deepEqual(extractMentions('@some_agent-2 hello'), ['some_agent-2']);
});

test('extractMentions: dedupes and lower-cases', () => {
  assert.deepEqual(extractMentions('@Host @host @HOST'), ['host']);
});

test('extractMentions: multiple distinct mentions, first-seen order', () => {
  assert.deepEqual(extractMentions('@alice and @bob then @alice again'), ['alice', 'bob']);
});

test('extractMentions: an email local part is not a mention', () => {
  assert.deepEqual(extractMentions('mail me at agent@example.com'), []);
});

test('extractMentions: an @ after a slash or dot (path/URL) is not a mention', () => {
  assert.deepEqual(extractMentions('see notes/@archive or read v1.2.@release'), []);
});

test('extractMentions: a token shorter than three characters is not a mention', () => {
  assert.deepEqual(extractMentions('@ab is too short'), []);
});

test('extractMentions: empty or null body is safe', () => {
  assert.deepEqual(extractMentions(''), []);
  assert.deepEqual(extractMentions(null), []);
});
