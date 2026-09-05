'use strict';

// Outbound email for magic links and change digests.
//
// Uses Resend's HTTP API rather than Gmail SMTP. Two reasons: Gmail SMTP
// was the mechanism behind the open relay removed from this codebase, and
// transactional mail from a personal Gmail account has poor deliverability.
// No new npm dependency -- it is one fetch call.
//
// With no API key configured, sending is DISABLED rather than silently
// failing: the caller is told, and in development the link is written to
// the log so the flow can be exercised locally.

const FROM = process.env.MAIL_FROM || 'TheBotique <onboarding@resend.dev>';

function configured() {
  return !!process.env.RESEND_API_KEY;
}

async function send({ to, subject, text }) {
  if (!configured()) {
    if (process.env.NODE_ENV !== 'production') {
      console.log(JSON.stringify({ event: 'mail_stub', to, subject, text }));
      return { ok: true, stubbed: true };
    }
    return { ok: false, error: 'email_not_configured' };
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ from: FROM, to: [to], subject, text })
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      // 403 from Resend on the shared onboarding domain means "you may only
      // email the account owner until you verify a domain". Called out
      // specifically because it fails for every visitor except the operator,
      // which looks exactly like nobody wanting to sign up.
      const restricted = res.status === 403 && /verify a domain|your own email/i.test(body);
      return {
        ok: false,
        error: restricted ? 'sender_domain_unverified' : `resend_${res.status}`,
        detail: body.slice(0, 300)
      };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { send, configured };
