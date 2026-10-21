'use strict';

const express = require('express');
const { requestMagicLink, consumeMagicLink, revokeSession, SESSION_TTL_MS } = require('../lib/auth');
const { isValidEmail } = require('../lib/validate');
const { sendMagicLinkEmail: sendMagicLinkEmailViaSmtp } = require('../lib/mailer');

function buildAuthRouter(store, { publicUrl, isDev, sendMagicLinkEmail = sendMagicLinkEmailViaSmtp }) {
  const router = express.Router();

  router.post('/request-link', async (req, res) => {
    const email = (req.body && req.body.email || '').trim().toLowerCase();
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'a valid email is required' });
    }

    let issuedToken = null;
    store.update((data) => {
      const result = requestMagicLink(data, email);
      issuedToken = result.token;
      return result.data;
    });

    const link = `${publicUrl}/api/auth/callback?token=${issuedToken}`;
    const mailResult = await sendMagicLinkEmail({ to: email, link });

    // Dev-only convenience so local proof runs don't need a working SMTP
    // relay: the link is only ever echoed back when VCPEER_LIVE_ENV=dev.
    if (isDev && !mailResult.sent) {
      return res.json({ ok: true, message: 'Check your email for a sign-in link.', devLink: link });
    }

    // Never silently report "check your email" when the email was not
    // actually sent (SMTP misconfigured, relay rejected it, shared mail
    // quota exhausted, etc.) - that leaves the visitor waiting on a link
    // that is never coming, with no way to know why. The issued token
    // stays valid for its full TTL, so a retried request or the existing
    // link (once delivery recovers) still works.
    if (!mailResult.sent) {
      console.error(`vcpeer-live auth: sign-in email not delivered (${mailResult.reason})`);
      return res.status(502).json({
        ok: false,
        error: 'We could not send the sign-in email right now. Please try again in a few minutes.',
      });
    }

    return res.json({ ok: true, message: 'Check your email for a sign-in link.' });
  });

  router.get('/callback', (req, res) => {
    const token = req.query.token;
    if (typeof token !== 'string' || token.length === 0) {
      return res.status(400).send('Missing token.');
    }

    let outcome = null;
    store.update((data) => {
      const result = consumeMagicLink(data, token);
      if (!result.ok) {
        outcome = result;
        return data;
      }
      outcome = result;
      return result.data;
    });

    if (!outcome.ok) {
      return res.status(400).send(`Sign-in link ${outcome.reason.replace('_', ' ')}. Request a new one.`);
    }

    res.cookie('vcpeer_live_session', outcome.session.token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: !isDev,
      maxAge: SESSION_TTL_MS,
    });
    return res.redirect('/live');
  });

  router.post('/logout', (req, res) => {
    const sessionToken = req.cookies && req.cookies.vcpeer_live_session;
    if (sessionToken) {
      store.update((data) => revokeSession(data, sessionToken));
    }
    res.clearCookie('vcpeer_live_session');
    return res.json({ ok: true });
  });

  return router;
}

module.exports = { buildAuthRouter };
