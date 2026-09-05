'use strict';

// Sign-in and watchlist. Four routes.
//
// Deliberately the only writable surface in TheBotique, and it writes
// exactly two things: an account row and a watch row.

const express = require('express');
const { esc, layout, SITE } = require('../sigil/wire');
const auth = require('./auth');
const mail = require('./mail');

const router = express.Router();
const FREE_LIMIT = 5;
const PLAN_LIMITS = { free: FREE_LIMIT, solo: 50, team: 500 };

const page = (title, body, extra = {}) => layout({
  title: `${title} — TheBotique`,
  canonical: `${SITE}/drift/${extra.path || 'watch'}`,
  noindex: true, // account pages are per-user; never index them
  body, ...extra
});

function notice(msg, kind = 'muted') {
  return `<div class="card"><p class="${kind}" style="margin:0">${esc(msg)}</p></div>`;
}

function mount(db) {
  // --- sign in ------------------------------------------------------------
  router.get('/drift/login', async (req, res, next) => {
    try {
      // A token in the query string means this is the click-through from
      // the emailed link.
      const { email, token } = req.query;
      if (email && token) {
        const acct = await auth.redeemLoginToken(db, email, token);
        if (!acct) {
          return res.status(400).send(page('Sign in', `<h1>That link did not work</h1>
${notice('Sign-in links expire after 15 minutes and can only be used once. Request a new one below.')}
${loginForm()}`, { path: 'login' }));
        }
        auth.setSession(res, acct.id);
        return res.redirect('/drift/watch');
      }
      if (req.query.out) { auth.clearSession(res); return res.redirect('/drift'); }
      res.send(page('Sign in', `<h1>Sign in</h1>
<p class="lede">No password. We email you a link that works once and expires in 15 minutes.</p>
${loginForm()}`, { path: 'login' }));
    } catch (e) { next(e); }
  });

  router.post('/drift/login', async (req, res, next) => {
    try {
      if (!auth.sessionsAvailable()) {
        return res.status(503).send(page('Sign in', `<h1>Sign-in is unavailable</h1>
${notice('SESSION_SECRET is not configured on this deployment, so sessions cannot be signed. Sign-in is disabled rather than issuing forgeable sessions.')}`, { path: 'login' }));
      }
      const email = auth.normalizeEmail(req.body && req.body.email);
      if (!auth.validEmail(email)) {
        return res.status(400).send(page('Sign in', `<h1>Sign in</h1>
${notice('That does not look like an email address.')}${loginForm()}`, { path: 'login' }));
      }
      const { token } = await auth.issueLoginToken(db, email);
      const link = `${SITE}/drift/login?email=${encodeURIComponent(email)}&token=${encodeURIComponent(token)}`;
      const sent = await mail.send({
        to: email,
        subject: 'Your sign-in link for TheBotique',
        text: `Sign in to TheBotique:\n\n${link}\n\nThis link works once and expires in 15 minutes.\nIf you did not request it, ignore this email.`
      });

      // A failed send must never be reported as a sent one. Telling someone
      // to check their inbox for a link that was never dispatched is the
      // worst possible first impression, and it is indistinguishable from
      // "this product does not work".
      if (!sent.ok) {
        (req.log || console).warn?.('sign-in email failed', { error: sent.error });
        const why = sent.error === 'sender_domain_unverified'
          ? 'Our sending domain is still being verified, so we cannot email you yet.'
          : sent.error === 'email_not_configured'
            ? 'Outbound email is not configured on this deployment yet.'
            : 'Our email provider rejected the message.';
        return res.status(503).send(page('We could not send that', `<h1>We could not send that link</h1>
${notice(`${why} This is our problem, not yours, and nothing is wrong with your address.`)}
<p class="muted">Everything you can read without an account still works &mdash; the whole
archive is public. Try again shortly, or write to
<a href="mailto:corrections@thebotique.ai">corrections@thebotique.ai</a> and we will let you know
the moment sign-in is working.</p>
<p><a href="/drift">Back to the archive</a></p>`, { path: 'login' }));
      }

      // Same confirmation regardless of whether the address already had an
      // account: the page must not reveal who has signed up.
      const body = `<h1>Check your email</h1>
${notice(`If ${email} is a valid address, a sign-in link is on its way. It works once and expires in 15 minutes.`)}`;
      res.send(page('Check your email', body, { path: 'login' }));
    } catch (e) { next(e); }
  });

  // --- watchlist ----------------------------------------------------------
  router.get('/drift/watch', async (req, res, next) => {
    try {
      const acct = await auth.currentAccount(db, req);
      if (!acct) return res.redirect('/drift/login');
      const rows = (await db.query(
        `SELECT w.source, w.slug, w.created_at,
                (SELECT count(*) FROM artifact_snapshots s
                  WHERE s.source = w.source AND s.slug = w.slug)::int obs
           FROM drift_watches w WHERE w.account_id = $1
          ORDER BY w.created_at DESC`, [acct.id]
      )).rows;
      const limit = PLAN_LIMITS[acct.plan] || FREE_LIMIT;
      const atLimit = rows.length >= limit;

      const body = `<h1>Your watchlist</h1>
<p class="lede">Signed in as ${esc(acct.email)} &middot; ${esc(acct.plan)} plan &middot;
<a href="/drift/login?out=1">sign out</a></p>
<div class="card"><p style="margin:0"><strong>${rows.length} of ${limit} watched</strong>${
  atLimit ? ' &mdash; you have reached the limit for this plan.' : ''}</p></div>
${rows.length ? `<div class="scroll"><table><tr><th>Extension</th><th>Source</th><th>Observations</th><th></th></tr>
${rows.map((r) => `<tr>
<td><a href="/drift/x/${esc(r.source)}/${encodeURIComponent(r.slug)}">${esc(r.slug)}</a></td>
<td>${esc(r.source)}</td><td>${r.obs}</td>
<td><form method="post" action="/drift/watch" style="margin:0">
<input type="hidden" name="source" value="${esc(r.source)}">
<input type="hidden" name="slug" value="${esc(r.slug)}">
<input type="hidden" name="remove" value="1">
<button type="submit" style="background:none;border:1px solid var(--rule);color:var(--ink-2);padding:3px 9px;cursor:pointer;font-family:var(--mono);font-size:11px">remove</button>
</form></td></tr>`).join('')}
</table></div>` : notice('Nothing watched yet. Open any extension page and add it.')}
<h2>Add by identifier</h2>
<form method="post" action="/drift/watch" class="card">
<div class="kv">
<label for="src">Source</label>
<select id="src" name="source" style="background:#fff;color:var(--ink);border:1px solid var(--rule);padding:8px">
${['npm-deep', 'npm', 'clawhub', 'mcp-registry', 'smithery'].map((s) => `<option value="${s}">${s}</option>`).join('')}
</select>
<label for="slg">Identifier</label>
<input id="slg" name="slug" required placeholder="e.g. mcp-remote"
 style="background:#fff;color:var(--ink);border:1px solid var(--rule);padding:8px;width:100%">
</div>
<p style="margin:12px 0 0"><button type="submit"
 class="cta">Watch it</button></p>
</form>`;
      res.send(page('Your watchlist', body));
    } catch (e) { next(e); }
  });

  router.post('/drift/watch', async (req, res, next) => {
    try {
      const acct = await auth.currentAccount(db, req);
      if (!acct) return res.redirect('/drift/login');
      const source = String((req.body && req.body.source) || '').trim();
      const slug = String((req.body && req.body.slug) || '').trim();
      if (!source || !slug) return res.redirect('/drift/watch');

      if (req.body.remove) {
        await db.query(
          'DELETE FROM drift_watches WHERE account_id = $1 AND source = $2 AND slug = $3',
          [acct.id, source, slug]
        );
        return res.redirect('/drift/watch');
      }

      // Only watchable if we actually observe it -- otherwise the alert
      // could never fire and the watch is a silent lie.
      const known = await db.query(
        'SELECT 1 FROM artifact_snapshots WHERE source = $1 AND slug = $2 LIMIT 1',
        [source, slug]
      );
      if (!known.rows.length) {
        return res.status(404).send(page('Not tracked', `<h1>Not tracked yet</h1>
${notice(`We have no observations for ${slug} on ${source}, so watching it could never produce an alert.`)}
<p><a href="/drift/watch">Back to your watchlist</a></p>`));
      }

      const count = (await db.query(
        'SELECT count(*)::int n FROM drift_watches WHERE account_id = $1', [acct.id]
      )).rows[0].n;
      const limit = PLAN_LIMITS[acct.plan] || FREE_LIMIT;
      if (count >= limit) {
        return res.status(402).send(page('Plan limit reached', `<h1>${count} of ${limit} watched</h1>
${notice(`The ${acct.plan} plan covers ${limit} extensions. Paid plans are not open yet — when they are, this is where you will upgrade.`)}
<p><a href="/drift/watch">Back to your watchlist</a></p>`));
      }

      // Record the current hash as already-notified, so adding a watch does
      // not immediately alert about a change that predates it.
      const latest = await db.query(
        `SELECT content_sha FROM artifact_snapshots WHERE source = $1 AND slug = $2
          ORDER BY fetched_at DESC LIMIT 1`, [source, slug]
      );
      await db.query(
        `INSERT INTO drift_watches (account_id, source, slug, notified_sha)
         VALUES ($1,$2,$3,$4) ON CONFLICT (account_id, source, slug) DO NOTHING`,
        [acct.id, source, slug, latest.rows[0] ? latest.rows[0].content_sha : null]
      );
      res.redirect('/drift/watch');
    } catch (e) { next(e); }
  });

  require('./billing').mount(router, db);
  return router;
}

function loginForm() {
  return `<form method="post" action="/drift/login" class="card">
<label for="em" style="display:block;color:var(--ink-2);font-size:14px;margin-bottom:6px">Email address</label>
<input id="em" name="email" type="email" required autocomplete="email" placeholder="you@example.com"
 style="background:#fff;color:var(--ink);border:1px solid var(--rule);padding:9px;width:100%;max-width:340px">
<p style="margin:12px 0 0"><button type="submit"
 class="cta">Email me a link</button></p>
</form>`;
}

module.exports = { mount, PLAN_LIMITS, FREE_LIMIT };
