'use strict';

// Billing through Lemon Squeezy as merchant of record.
//
// MoR rather than raw Stripe on purpose: Lemon Squeezy is the legal seller,
// so EU VAT registration and filing, and US state sales-tax nexus on SaaS,
// are their obligation rather than a solo operator's. The extra ~2% is the
// cheapest compliance insurance available at this size.
//
// We never see or store a card. Checkout is hosted; we only receive a
// signed webhook telling us a plan changed.
//
// The security rule here is the one this codebase already got wrong once:
// /api/credits/deposit credited a balance on the caller's say-so. Nothing
// below grants a plan on anything except a signature we verified over the
// exact raw bytes.

const crypto = require('crypto');
const { esc, layout, SITE } = require('../sigil/wire');
const { PLAN_LIMITS } = require('./account-routes');

const PLANS = [
  { id: 'free', name: 'Watch', price: '$0', limit: 5, latency: 'daily',
    history: '30 days', blurb: 'Everything works. Fewer things watched.' },
  { id: 'solo', name: 'Solo', price: '$19', limit: 50, latency: 'daily',
    history: '1 year', blurb: 'For one person keeping an eye on their own stack.' },
  { id: 'team', name: 'Team', price: '$79', limit: 500, latency: '6-hour',
    history: 'full archive', blurb: 'Unlimited seats. Per-seat billing punishes the behaviour we want.' }
];

// Which variant maps to which plan, configured by env so the plan can be
// created in the Lemon Squeezy dashboard without a code change.
function variantMap() {
  return {
    [String(process.env.LS_VARIANT_SOLO || '')]: 'solo',
    [String(process.env.LS_VARIANT_TEAM || '')]: 'team'
  };
}

const checkoutConfigured = () =>
  !!(process.env.LS_CHECKOUT_SOLO && process.env.LS_CHECKOUT_TEAM);

// --- signature -------------------------------------------------------------
// HMAC-SHA256 over the raw body, hex digest, compared in constant time.
// Returns false when no secret is configured: an unverifiable webhook is
// never processed, because processing it would let anyone grant themselves
// a paid plan by POSTing JSON.
function verifySignature(rawBody, header) {
  const secret = process.env.LS_WEBHOOK_SECRET;
  if (!secret || !header || !Buffer.isBuffer(rawBody)) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(String(header), 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// --- webhook handling ------------------------------------------------------
const ACTIVE = new Set([
  'subscription_created', 'subscription_updated', 'subscription_resumed',
  'subscription_unpaused', 'subscription_payment_success'
]);
const INACTIVE = new Set([
  'subscription_cancelled', 'subscription_expired', 'subscription_paused'
]);

async function applyEvent(db, event, payload, ip) {
  const attrs = (payload && payload.data && payload.data.attributes) || {};
  const email = String(attrs.user_email || '').trim().toLowerCase();
  if (!email) return { ok: false, reason: 'no_email' };

  const variant = String(attrs.variant_id || '');
  const plan = variantMap()[variant];
  const customer = attrs.customer_id ? String(attrs.customer_id) : null;

  if (ACTIVE.has(event)) {
    if (!plan) return { ok: false, reason: 'unmapped_variant' };
    // California AB 2863 requires retaining proof of affirmative consent to
    // auto-renewal for 3+ years. Recorded at the moment of purchase rather
    // than reconstructed later.
    await db.query(
      `INSERT INTO drift_accounts (email, plan, stripe_customer,
                                   renewal_consent_at, renewal_consent_ip, renewal_consent_text)
            VALUES ($1,$2,$3, now(), $4, $5)
       ON CONFLICT (email) DO UPDATE SET
            plan = $2, stripe_customer = COALESCE($3, drift_accounts.stripe_customer),
            renewal_consent_at = now(), renewal_consent_ip = $4, renewal_consent_text = $5`,
      [email, plan, customer, ip || null,
       `Lemon Squeezy ${event}; variant ${variant}; renews automatically until cancelled.`]
    );
    return { ok: true, plan, email };
  }

  if (INACTIVE.has(event)) {
    await db.query('UPDATE drift_accounts SET plan = $1 WHERE email = $2', ['free', email]);
    return { ok: true, plan: 'free', email };
  }
  return { ok: false, reason: 'ignored_event' };
}

// --- routes ----------------------------------------------------------------
function mount(router, db, logger = console) {
  // Public, indexable pricing page.
  router.get('/drift/pricing', async (req, res, next) => {
    try {
      const live = checkoutConfigured();
      // Until checkout exists, this page leads with the free tier rather
      // than a price table nobody can act on. Showing prices you cannot
      // charge is a worse first impression than showing none.
      const body = live ? `
<h1>Pricing</h1>
<p class="lede">Every plan has every feature. What changes is how much you watch,
how far back you can look, and how fast you hear about it.</p>
<div class="scroll"><table>
<tr><th>Plan</th><th>Price</th><th>Watched</th><th>Detection</th><th>History</th></tr>
${PLANS.map((p) => `<tr>
<td><strong>${esc(p.name)}</strong><br><span class="muted">${esc(p.blurb)}</span></td>
<td>${esc(p.price)}${p.id === 'free' ? '' : '<span class="muted">/mo</span>'}</td>
<td>${p.limit}</td><td>${esc(p.latency)}</td><td>${esc(p.history)}</td></tr>`).join('')}
</table></div>
<p style="margin-top:20px">
<a href="${esc(process.env.LS_CHECKOUT_SOLO)}" rel="nofollow"
 class="cta" style="margin-right:10px">Get Solo</a>
<a href="${esc(process.env.LS_CHECKOUT_TEAM)}" rel="nofollow"
 class="cta" style="background:none;color:var(--ink)!important;border:1px solid var(--ink)">Get Team</a></p>

<h2>What you are paying for</h2>
<p>Not access to the findings. Every observation we publish is free and public, including
anything adverse, and it stays that way. What a subscription buys is the archive depth, the
number of things watched, and being told rather than having to look.</p>

<h2>Billing</h2>
<p class="muted">Payments are processed by Lemon Squeezy, which acts as the merchant of record
and appears on your statement. Subscriptions renew monthly until cancelled, and can be cancelled
at any time from the link in your receipt. Full refund within 14 days, no questions asked.</p>`
: `
<h1>Free while we find out if this is useful</h1>
<p class="lede">TheBotique is free right now. Not a trial, not a countdown &mdash; there is
nothing to buy yet, because we would rather find out whether it is worth paying for before
asking anyone to.</p>

<div class="card"><dl class="kv">
<dt>Price</dt><dd><strong>$0</strong>, no card</dd>
<dt>Watch up to</dt><dd>5 extensions</dd>
<dt>Alerts</dt><dd>Email, once a day, when a watched record changes</dd>
<dt>History</dt><dd>30 days, and the public archive is unlimited</dd>
<dt>Sign-in</dt><dd>An email address. No password.</dd>
</dl></div>
<p><a href="/drift/login"
 class="cta">Start watching</a></p>

<h2>What will never be paid</h2>
<p>Every observation we publish stays free and public, including anything adverse. If we ever
charge, it will be for archive depth, how many things you watch, and how fast you hear &mdash;
never for access to a finding about a piece of software. That is a commitment about what this
is, not a launch promotion.</p>

<h2>What happens if you are watching things when that changes</h2>
<p class="muted">You keep what you have. Nothing you can do today gets taken away and sold back
to you later. If a paid tier appears, it will be for more than the free tier does now.</p>`;
      // The description must match the page. Advertising a $19 plan in a
      // search result that lands on "nothing is for sale yet" is a broken
      // promise before anyone has even arrived.
      res.send(layout({
        title: live ? 'Pricing — TheBotique' : 'Free while we find out if this is useful — TheBotique',
        description: live
          ? 'TheBotique pricing. Free tier watches 5 extensions with 30 days of history; Solo $19/mo watches 50; Team $79/mo watches 500 with unlimited seats.'
          : 'TheBotique is free: watch up to 5 AI agent extensions and get an email when one of them changes. No card, no trial countdown.',
        canonical: `${SITE}/drift/pricing`,
        body
      }));
    } catch (e) { next(e); }
  });

  // Signed webhook. Raw body is mounted earlier in index.js.
  router.post('/drift/billing/webhook', async (req, res) => {
    const sig = req.headers['x-signature'];
    if (!verifySignature(req.body, sig)) {
      // Deliberately terse and identical for every failure mode, so the
      // response cannot be used to probe whether a secret is configured.
      logger.warn && logger.warn('billing webhook rejected', { event: 'ls_webhook_rejected' });
      return res.status(401).json({ error: 'invalid signature' });
    }
    let payload;
    try { payload = JSON.parse(req.body.toString('utf8')); }
    catch (e) { return res.status(400).json({ error: 'invalid json' }); }

    const event = (payload.meta && payload.meta.event_name) || '';
    try {
      const r = await applyEvent(db, event, payload, req.ip);
      logger.info && logger.info('billing webhook applied', { event, ok: r.ok, reason: r.reason || null });
      // 200 even for events we ignore: a non-2xx makes Lemon Squeezy retry
      // an event that will never succeed.
      return res.json({ received: true });
    } catch (e) {
      logger.error && logger.error('billing webhook failed', { event, error: e.message });
      return res.status(500).json({ error: 'processing failed' });
    }
  });

  return router;
}

module.exports = { mount, verifySignature, applyEvent, PLANS, checkoutConfigured };
