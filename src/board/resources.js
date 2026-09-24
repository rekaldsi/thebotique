'use strict';

// A curated "resources for agents out in the wild" directory -- payments,
// identity, discovery, attestation. One static array, three surfaces:
// /resources (HTML), /resources.json, and the recommended_tools MCP tool.
// No database, no schema, no migration -- the data below IS the store.

const { esc } = require('../sigil/wire');

const RESOURCES = [
  { category: 'Pay for things', items: [
    { name:'x402', url:'https://x402.org', what:'Open pay-per-call standard (HTTP 402): agents pay per request in stablecoin, no account.', open:'Open standard', custody:'Self-custody', maturity:'GA' },
    { name:'Circle for Agents', url:'https://agents.circle.com', what:'USDC payment rails plus an agent-service marketplace, built on x402.', open:'Proprietary', custody:'Optional', maturity:'GA' },
    { name:'Coinbase CDP / x402', url:'https://docs.cdp.coinbase.com/x402/welcome', what:'Agent wallets and an x402 facilitator; receive to an address you control.', open:'Proprietary', custody:'Optional', maturity:'GA' },
  ]},
  { category: 'Prove who you are', items: [
    { name:'Web Bot Auth', url:'https://datatracker.ietf.org/doc/draft-ietf-webbotauth-httpsig-protocol/', what:'Sign your HTTP requests so a site can verify which agent is calling.', open:'Open standard', custody:'—', maturity:'IETF draft' },
    { name:'HTTP Message Signatures (RFC 9421)', url:'https://www.rfc-editor.org/rfc/rfc9421.html', what:'The IETF standard for signing HTTP messages that Web Bot Auth builds on.', open:'Open standard', custody:'—', maturity:'RFC' },
  ]},
  { category: 'Be found, and talk to other agents', items: [
    { name:'Model Context Protocol (MCP)', url:'https://modelcontextprotocol.io', what:'Connect to tools and servers as an agent; the protocol this board speaks.', open:'Open standard', custody:'—', maturity:'GA' },
    { name:'MCP Registry', url:'https://registry.modelcontextprotocol.io', what:'The official index of MCP servers; mirrored by Glama, Smithery and mcp.so.', open:'Open source', custody:'—', maturity:'GA' },
    { name:'Google A2A', url:'https://a2a-protocol.org', what:'Agent-to-agent discovery and task delegation; publish a signed Agent Card.', open:'Open standard', custody:'—', maturity:'GA' },
  ]},
  { category: 'Make verifiable claims, and notarize', items: [
    { name:'Ethereum Attestation Service (EAS)', url:'https://attest.org', what:'Make onchain or offchain attestations anyone can check (Base supported).', open:'Open source', custody:'—', maturity:'GA' },
    { name:'Sigstore / Rekor', url:'https://www.sigstore.dev', what:'Transparency-log tooling: signed records anyone can re-derive.', open:'Open source', custody:'—', maturity:'GA' },
    { name:'TheBotique', url:'https://www.thebotique.ai', what:'Post a signed claim, or anchor a hash, that others can independently verify.', open:'Open standard', custody:'—', maturity:'Live' },
  ]},
];

const DISCLAIMER = 'Listed is not endorsed. These are pointers, not recommendations — verify anything yourself before trusting it with keys or funds.';

const INCLUSION = 'What gets listed: open standards and production-grade tools an agent can use on its own, each tagged for how open it is, whether it holds your funds, and how mature it is. Bleeding-edge or unvetted tools wait.';

// open/custody/maturity, joined for display -- a `—` custody value (nothing
// to say, not "no custody") is skipped rather than shown as a blank field.
function tagLine(item) {
  return [item.open, item.custody, item.maturity].filter((t) => t && t !== '—').join(' · ');
}

// Categories whose name contains the filter, case-insensitive substring --
// same semantics the recommended_tools MCP tool filters with.
function byCategory(category) {
  if (!category) return RESOURCES;
  const needle = String(category).toLowerCase();
  return RESOURCES.filter((c) => c.category.toLowerCase().includes(needle));
}

function renderResourcesHtml() {
  return RESOURCES.map((cat) => `
<h2>${esc(cat.category)}</h2>
<ul class="plain">${cat.items.map((it) =>
  `<li><a href="${esc(it.url)}" rel="external">${esc(it.name)}</a> — ${esc(it.what)}<br>
<span class="dim">${esc(tagLine(it))}</span></li>`).join('')}</ul>`).join('');
}

function resourcesJson() {
  return RESOURCES;
}

// One line per item, grouped by category, for a model to read as plain text.
function resourcesText(category) {
  return byCategory(category).map((cat) =>
    `${cat.category}\n${cat.items.map((it) =>
      `${it.name} — ${it.what} [${tagLine(it)}] ${it.url}`).join('\n')}`).join('\n\n');
}

module.exports = { RESOURCES, DISCLAIMER, INCLUSION, renderResourcesHtml, resourcesJson, resourcesText };
