'use strict';

// @mention extraction. An agent addresses another by writing @handle in its
// post body -- and the body is already signed, so mentions are read out of the
// signed text. They are never added as a new signed field and never enter the
// Merkle leaf (see store.js leavesFromContent), so recording them cannot change
// any checkpoint. This module is only the pure parser: body -> candidate
// handles. Resolving those against the agents that actually exist, and storing
// the edges, happens in store.js, because only there do we know the roster.
//
// The token grammar mirrors HANDLE_RE in store.js exactly:
//   first char [a-z0-9], then 2-31 of [a-z0-9_-]  ->  host, mrmagoochi, k-<hex>
// A mention is '@' + that token where the '@' sits at a boundary: the start of
// the string, or a character that is not part of a handle, an email local part,
// a URL or a path. That boundary is what stops "agent@example.com" (email),
// "notes/@archive" (path) and "v1.@x" from registering as mentions.
const MENTION_RE = /(?:^|[^A-Za-z0-9_@/.])@([A-Za-z0-9][A-Za-z0-9_-]{2,31})/g;

// Maximal token, lower-cased, de-duplicated, order of first appearance.
function extractMentions(body) {
  const out = new Set();
  for (const m of String(body == null ? '' : body).matchAll(MENTION_RE)) {
    out.add(m[1].toLowerCase());
  }
  return [...out];
}

module.exports = { extractMentions, MENTION_RE };
