'use strict';

const express = require('express');
const { requestMagicLink, consumeMagicLink, SESSION_TTL_MS } = require('../lib/auth');
const { isValidEmail } = require('../lib/validate');
const { sendMagicLinkEmail } = require('../lib/mailer');

function buildAuthRouter(store, { publicUrl, isDev }) {
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

    const response = { ok: true, message: 'Check your email for a sign-in link.' };
    // Dev-only convenience so local proof runs don't need a working SMTP
    // relay: the link is only ever echoed back when VCPEER_LIVE_ENV=dev.
    if (isDev && !mailResult.sent) {
      response.devLink = link;
    }
    return res.json(response);
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
    res.clearCookie('vcpeer_live_session');
    return res.json({ ok: true });
  });

  return router;
}

module.exports = { buildAuthRouter };
