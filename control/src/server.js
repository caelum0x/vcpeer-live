'use strict';

const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');

const { JsonStore } = require('./lib/store');
const { buildAuthRouter } = require('./routes/auth');
const { buildDestinationsRouter } = require('./routes/destinations');
const { buildLiveRouter } = require('./routes/live');
const { buildBroadcastsRouter } = require('./routes/broadcasts');
const { buildOauthRouter } = require('./routes/oauth');
const { buildBillingRouter, buildBillingWebhookHandler } = require('./routes/billing');
const { buildTeamRouter } = require('./routes/team');
const { resolveSession } = require('./lib/auth');
const { checkFailuresAndNotify } = require('./lib/healthAlerts');
const { sendStreamFailureEmail } = require('./lib/mailer');

function createApp(overrides = {}) {
  const isDev = (process.env.VCPEER_LIVE_ENV || 'dev') === 'dev';
  const dataFile = overrides.dataFile || process.env.DATA_FILE || path.join(__dirname, '..', 'data', 'db.json');
  const sharedDir = overrides.sharedDir || process.env.FANOUT_SHARED_DIR || path.join(__dirname, '..', 'data', 'shared');
  const publicUrl = overrides.publicUrl || process.env.PUBLIC_URL || 'http://localhost:4000';
  const rtmpPublicUrl = overrides.rtmpPublicUrl || process.env.RTMP_PUBLIC_URL || 'rtmp://localhost:1935';
  const whipPublicUrl = overrides.whipPublicUrl || process.env.WHIP_PUBLIC_URL || 'http://localhost:8889';
  const ownCastStreamKey = overrides.ownCastStreamKey || process.env.OWNCAST_STREAM_KEY || 'abc123';

  const store = overrides.store || new JsonStore(dataFile);

  const app = express();
  // Mounted BEFORE express.json() with its own express.raw() middleware -
  // Dodo webhook signature verification needs the exact raw bytes sent,
  // which express.json() would otherwise have already parsed away by
  // the time any router below saw the request. See routes/billing.js.
  app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), buildBillingWebhookHandler(store));
  app.use(express.json());
  app.use(cookieParser());
  // `extensions: ['html']` lets clean URLs like /vs/restream resolve to
  // vs/restream.html on disk - the comparison pages link to each other and
  // appear in the sitemap without a .html suffix.
  app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));

  app.get('/healthz', (req, res) => res.json({ ok: true }));

  app.get('/api/me', (req, res) => {
    const user = resolveSession(store.get(), req.cookies && req.cookies.vcpeer_live_session);
    if (!user) return res.status(401).json({ error: 'not signed in' });
    return res.json({ email: user.email });
  });

  app.use('/api/auth', buildAuthRouter(store, { publicUrl, isDev, rateLimiters: overrides.authRateLimiters }));
  app.use('/api/destinations', buildDestinationsRouter(store, { sharedDir, ownCastStreamKey }));
  app.use(
    '/api/live',
    buildLiveRouter(store, { rtmpPublicUrl, whipPublicUrl, sharedDir, ownCastStreamKey })
  );
  app.use('/api/broadcasts', buildBroadcastsRouter(store));
  app.use('/api/oauth', buildOauthRouter(store, { publicUrl }));
  app.use('/api/billing', buildBillingRouter(store, { publicUrl }));
  app.use('/api/team', buildTeamRouter(store, { publicUrl, isDev }));

  app.get('/live', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'live.html'));
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error('vcpeer-live: unhandled error:', err.message);
    res.status(500).json({ error: 'internal error' });
  });

  return { app, store };
}

if (require.main === module) {
  const { app, store } = createApp();
  const port = Number(process.env.PORT || 4000);
  app.listen(port, () => {
    console.log(`VCPeer Live control app listening on :${port}`);
  });

  // Independent of any open dashboard tab (the 5s /api/live/status poll
  // only runs while someone is looking at /live) - this is what actually
  // notices a destination that silently died mid-broadcast and emails
  // the signed-in user. Only started for the real server process, never
  // inside createApp() itself, so importing createApp() in a script or a
  // future test never leaves a background timer running.
  const sharedDir = process.env.FANOUT_SHARED_DIR || path.join(__dirname, '..', 'data', 'shared');
  const healthAlertIntervalMs = Number(process.env.HEALTH_ALERT_INTERVAL_MS || 15000);
  setInterval(() => {
    checkFailuresAndNotify(store.get(), { sharedDir, sendEmail: sendStreamFailureEmail })
      .then(({ data, sent }) => {
        store.update(() => data);
        if (sent.length) {
          console.log(`vcpeer-live health-alerts: sent ${sent.length} failure alert(s)`);
        }
      })
      .catch((err) => {
        console.error('vcpeer-live health-alerts: check failed:', err.message);
      });
  }, healthAlertIntervalMs);
}

module.exports = { createApp };
