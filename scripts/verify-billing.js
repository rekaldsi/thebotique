#!/usr/bin/env node
'use strict';

// Checks that Lemon Squeezy billing is wired correctly, end to end.
// Run after configuring the store:   node scripts/verify-billing.js
//
// Reads config from Railway if the CLI is linked, otherwise from the local
// environment. Never prints a secret value -- only whether it is present
// and whether it works.

const { execSync } = require('child_process');
const crypto = require('crypto');

const SITE = process.env.SITE || 'https://www.thebotique.ai';
const WEBHOOK = `${SITE}/drift/billing/webhook`;

function railwayVars() {
  try {
    const out = execSync('railway variables --kv', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const map = {};
    for (const line of out.split('\n')) {
      const i = line.indexOf('=');
      if (i > 0) map[line.slice(0, i).trim()] = line.slice(i + 1);
    }
    return map;
  } catch (e) {
    return null;
  }
}

const REQUIRED = [
  ['LS_WEBHOOK_SECRET', 'Signing secret from the Lemon Squeezy webhook you created'],
  ['LS_VARIANT_SOLO', 'Numeric variant id of the $19 Solo plan'],
  ['LS_VARIANT_TEAM', 'Numeric variant id of the $79 Team plan'],
  ['LS_CHECKOUT_SOLO', 'Public checkout URL for Solo'],
  ['LS_CHECKOUT_TEAM', 'Public checkout URL for Team']
];
const ALSO = [
  ['RESEND_API_KEY', 'Outbound email for sign-in links and change digests'],
  ['SESSION_SECRET', 'Signs session cookies; without it sign-in disables itself'],
  ['GITHUB_TOKEN', 'Raises repo-liveness checks from 60/hr to 5,000/hr']
];

function checkVar(vars, name) {
  const v = vars ? vars[name] : process.env[name];
  if (!v) return { ok: false, note: 'not set' };
  if (/^railway |&&/.test(v) || /\s{2,}/.test(v)) {
    return { ok: false, note: 'looks like a pasted command, not a value' };
  }
  return { ok: true, note: `set (${v.length} chars)` };
}

async function main() {
  const vars = railwayVars();
  console.log(vars ? 'Reading config from Railway.\n' : 'Railway CLI unavailable; reading local environment.\n');

  let missing = 0;
  console.log('Required for paid plans');
  for (const [name, why] of REQUIRED) {
    const r = checkVar(vars, name);
    if (!r.ok) missing++;
    console.log(`  ${r.ok ? 'OK  ' : 'MISS'}  ${name.padEnd(20)} ${r.note}${r.ok ? '' : `  — ${why}`}`);
  }
  console.log('\nAlso worth having');
  for (const [name, why] of ALSO) {
    const r = checkVar(vars, name);
    console.log(`  ${r.ok ? 'OK  ' : '--  '}  ${name.padEnd(20)} ${r.note}${r.ok ? '' : `  — ${why}`}`);
  }

  // Variant ids must be numeric or the webhook can never map an event to a plan.
  for (const n of ['LS_VARIANT_SOLO', 'LS_VARIANT_TEAM']) {
    const v = vars ? vars[n] : process.env[n];
    if (v && !/^\d+$/.test(v.trim())) {
      console.log(`\n  WARNING  ${n} is not numeric ("${v.slice(0, 24)}"). Variant ids are numbers.`);
      missing++;
    }
  }

  console.log('\nLive endpoint behaviour');
  const unsigned = await fetch(WEBHOOK, { method: 'POST', body: '{}' })
    .then((r) => r.status).catch(() => 0);
  console.log(`  ${unsigned === 401 ? 'OK  ' : 'FAIL'}  unsigned webhook rejected            ${unsigned} (expect 401)`);

  const bogus = await fetch(WEBHOOK, {
    method: 'POST', headers: { 'X-Signature': 'deadbeef' }, body: '{}'
  }).then((r) => r.status).catch(() => 0);
  console.log(`  ${bogus === 401 ? 'OK  ' : 'FAIL'}  bad-signature webhook rejected        ${bogus} (expect 401)`);

  const pricing = await fetch(`${SITE}/drift/pricing`).then((r) => r.status).catch(() => 0);
  console.log(`  ${pricing === 200 ? 'OK  ' : 'FAIL'}  pricing page                          ${pricing} (expect 200)`);

  const html = await fetch(`${SITE}/drift/pricing`).then((r) => r.text()).catch(() => '');
  const open = !html.includes('not open yet');
  console.log(`  ${open ? 'OK  ' : '--  '}  paid plans shown as purchasable       ${open ? 'yes' : 'no — checkout URLs not set'}`);

  // A signed round-trip proves the deployed secret matches the one you hold.
  const secret = vars ? vars.LS_WEBHOOK_SECRET : process.env.LS_WEBHOOK_SECRET;
  if (secret) {
    const body = JSON.stringify({
      meta: { event_name: 'subscription_updated' },
      data: { attributes: { user_email: 'verify@thebotique.ai', variant_id: '0' } }
    });
    const sig = crypto.createHmac('sha256', secret).update(body).digest('hex');
    const st = await fetch(WEBHOOK, {
      method: 'POST', headers: { 'X-Signature': sig, 'content-type': 'application/json' }, body
    }).then((r) => r.status).catch(() => 0);
    // variant 0 is unmapped on purpose: accepted, but grants nothing.
    console.log(`  ${st === 200 ? 'OK  ' : 'FAIL'}  correctly signed webhook accepted     ${st} (expect 200)`);
    console.log('        (used an unmapped variant, so no plan was granted to anyone)');
  } else {
    console.log('  --    signed round-trip skipped — LS_WEBHOOK_SECRET not readable here');
  }

  console.log(missing === 0
    ? '\nBilling looks fully configured.'
    : `\n${missing} item(s) still needed before paid plans can complete.`);
}

main().catch((e) => { console.error('verify failed:', e.message); process.exit(1); });
