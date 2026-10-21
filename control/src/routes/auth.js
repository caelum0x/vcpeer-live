'use strict';

const express = require('express');
const { requestMagicLink, consumeMagicLink, revokeSession, SESSION_TTL_MS } = require('../lib/auth');
const { isValidEmail } = require('../lib/validate');
const { sendMagicLinkEmail: sendMagicLinkEmailViaSmtp } = require('../lib/mailer');
const { createRateLimiter } = require('../lib/rateLimit');

// Defaults for the real deploy: generous enough that a streamer who
// retries a slow-to-arrive email isn't blocked, tight enough to stop
// request-link from being used to mail-bomb a victim's inbox or burn
// through the shared Scribase Mail SMTP quota. Per-email is the one that
// actually matters for the "bomb a victim" case (it's not defeated by
// the attacker spreading requests across many source IPs); per-IP is a
// secondary guard against one source hammering many different emails.
const DEFAULT_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_PER_EMAIL_MAX = 5;
const DEFAULT_PER_IP_MAX = 20;

function buildAuthRouter(
  store,
  { publicUrl, isDev, sendMagicLinkEmail = sendMagicLinkEmailViaSmtp, rateLimiters }
) {
  const router = express.Router();
  const limiters = rateLimiters || {
    perEmail: createRateLimiter({ windowMs: DEFAULT_RATE_LIMIT_WINDOW_MS, max: DEFAULT_PER_EMAIL_MAX }),
    perIp: createRateLimiter({ windowMs: DEFAULT_RATE_LIMIT_WINDOW_MS, max: DEFAULT_PER_IP_MAX }),
  };

  router.post('/request-link', async (req, res) => {
    const email = (req.body && req.body.email || '').trim().toLowerCase();
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'a valid email is required' });
    }

    const ip = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
    const emailCheck = limiters.perEmail.check(`email:${email}`);
    const ipCheck = limiters.perIp.check(`ip:${ip}`);
    if (emailCheck.limited || ipCheck.limited) {
      const retryAfterMs = Math.max(emailCheck.retryAfterMs, ipCheck.retryAfterMs);
      res.set('Retry-After', String(Math.ceil(retryAfterMs / 1000)));
      return res.status(429).json({ error: 'Too many sign-in requests. Please try again later.' });
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
