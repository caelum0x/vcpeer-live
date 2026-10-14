'use strict';

const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');

const { JsonStore } = require('./lib/store');
const { buildAuthRouter } = require('./routes/auth');
const { buildDestinationsRouter } = require('./routes/destinations');
const { buildLiveRouter } = require('./routes/live');
const { resolveSession } = require('./lib/auth');

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
  app.use(express.json());
  app.use(cookieParser());
  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.get('/healthz', (req, res) => res.json({ ok: true }));

  app.get('/api/me', (req, res) => {
    const user = resolveSession(store.get(), req.cookies && req.cookies.vcpeer_live_session);
    if (!user) return res.status(401).json({ error: 'not signed in' });
    return res.json({ email: user.email });
  });

  app.use('/api/auth', buildAuthRouter(store, { publicUrl, isDev }));
  app.use('/api/destinations', buildDestinationsRouter(store));
  app.use(
    '/api/live',
    buildLiveRouter(store, { rtmpPublicUrl, whipPublicUrl, sharedDir, ownCastStreamKey })
  );

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
  const { app } = createApp();
  const port = Number(process.env.PORT || 4000);
  app.listen(port, () => {
    console.log(`VCPeer Live control app listening on :${port}`);
  });
}

module.exports = { createApp };
