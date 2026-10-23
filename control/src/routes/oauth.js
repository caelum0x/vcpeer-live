'use strict';

const crypto = require('crypto');
const express = require('express');

const { requireAuth } = require('../lib/auth');
const twitch = require('../lib/oauth/twitch');

const STATE_TTL_MS = 5 * 60 * 1000;
const PENDING_TTL_MS = 5 * 60 * 1000;

/**
 * OAuth "Connect <platform>" flow. Only Twitch exposes a real stream-key
 * API (Helix `GET /streams/key`, scope `channel:read:stream_key`) - Kick
 * and YouTube's public APIs don't expose a raw ingest key to third-party
 * apps at all, so for those two platforms the dashboard does a much
 * simpler client-side-only URL autofill (see public/js/live.js) with no
 * route here. This file is Twitch-only.
 *
 * State is kept in-process memory, never in the JSON store or on disk:
 * - `states`: CSRF nonce -> {userId, expiresAt}, created by /start,
 *   consumed (deleted) by /callback. Prevents a forged callback request
 *   from attaching Twitch credentials fetched for one user's session to
 *   a different signed-in user.
 * - `pending`: userId -> {platform, rtmpUrl, streamKey, expiresAt},
 *   written by /callback, read-and-deleted (one-time) by /pending. This
 *   is the ONLY place a Twitch stream key ever exists in plaintext
 *   outside the user's own browser, and only for up to 5 minutes or one
 *   read, whichever comes first - it is never written to the JSON store
 *   or any log line. The existing POST /api/destinations route is what
 *   actually persists it (AES-256-GCM encrypted, same as a manually
 *   typed key) once the user reviews the auto-filled form and submits.
 */
const states = new Map();
const pending = new Map();

function pruneExpired(map) {
  const now = Date.now();
  for (const [key, value] of map) {
    if (value.expiresAt <= now) map.delete(key);
  }
}

function buildOauthRouter(store, { publicUrl }) {
  const router = express.Router();

  router.get('/twitch/status', (req, res) => {
    res.json({ configured: twitch.isConfigured() });
  });

  router.get('/twitch/start', requireAuth(store), (req, res) => {
    if (!twitch.isConfigured()) {
      return res.status(501).json({
        error:
          'Twitch connect is not configured yet (needs a free Twitch Developer Console app - TWITCH_CLIENT_ID/TWITCH_CLIENT_SECRET). Use the manual form below instead.',
      });
    }
    pruneExpired(states);
    const state = crypto.randomBytes(16).toString('hex');
    states.set(state, { userId: req.user.id, expiresAt: Date.now() + STATE_TTL_MS });
    const redirectUri = `${publicUrl}/api/oauth/twitch/callback`;
    return res.redirect(twitch.buildAuthorizeUrl({ redirectUri, state }));
  });

  router.get('/twitch/callback', async (req, res) => {
    const { code, state, error, error_description: errorDescription } = req.query;

    if (error) {
      console.error('vcpeer-live oauth: Twitch denied/errored:', error, errorDescription || '');
      return res.redirect('/live?twitchError=' + encodeURIComponent(String(error)));
    }

    pruneExpired(states);
    const stateEntry = typeof state === 'string' ? states.get(state) : null;
    if (!stateEntry) {
      return res.redirect('/live?twitchError=' + encodeURIComponent('expired_or_invalid_state'));
    }
    states.delete(state); // one-time use, regardless of outcome below

    if (typeof code !== 'string' || !code) {
      return res.redirect('/live?twitchError=' + encodeURIComponent('missing_code'));
    }

    try {
      const redirectUri = `${publicUrl}/api/oauth/twitch/callback`;
      const creds = await twitch.fetchDestinationCredentials({ code, redirectUri });
      pruneExpired(pending);
      pending.set(stateEntry.userId, { ...creds, expiresAt: Date.now() + PENDING_TTL_MS });
      return res.redirect('/live?twitchConnected=1');
    } catch (err) {
      // Never let the raw error (which could echo back query params) hit
      // the redirect URL - log server-side, send a generic flag only.
      console.error('vcpeer-live oauth: Twitch credential fetch failed:', err.message);
      return res.redirect('/live?twitchError=' + encodeURIComponent('fetch_failed'));
    }
  });

  // One-time read: the dashboard polls this right after redirecting back
  // from Twitch (`?twitchConnected=1`) to pick up the auto-filled
  // destination fields, then this entry is gone - a page refresh does
  // not re-serve a stream key that already made it into the form once.
  router.get('/twitch/pending', requireAuth(store), (req, res) => {
    pruneExpired(pending);
    const entry = pending.get(req.user.id);
    if (!entry) return res.json({ ok: false });
    pending.delete(req.user.id);
    return res.json({ ok: true, platform: entry.platform, rtmpUrl: entry.rtmpUrl, streamKey: entry.streamKey });
  });

  return router;
}

module.exports = { buildOauthRouter };
