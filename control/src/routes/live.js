'use strict';

const express = require('express');

const { requireAuth } = require('../lib/auth');
const { getOrCreateIngestKey, writeFanoutFile, readFanoutStatus } = require('../lib/live');

function buildLiveRouter(store, { rtmpPublicUrl, whipPublicUrl, sharedDir, ownCastStreamKey }) {
  const router = express.Router();
  router.use(requireAuth(store));

  router.get('/credentials', (req, res) => {
    let ingestKey;
    store.update((data) => {
      const result = getOrCreateIngestKey(data, req.user.id);
      ingestKey = result.key;
      return result.data;
    });
    return res.json({
      rtmpUrl: `${rtmpPublicUrl}/live/${ingestKey}`,
      whipUrl: `${whipPublicUrl}/live/${ingestKey}/whip`,
      watchUrl: `${process.env.OWNCAST_PUBLIC_URL || 'http://localhost:8080'}`,
    });
  });

  router.post('/go', (req, res) => {
    const data = store.get();
    let ingestKey;
    store.update((current) => {
      const result = getOrCreateIngestKey(current, req.user.id);
      ingestKey = result.key;
      return result.data;
    });

    const mine = data.destinations.filter((d) => d.userId === req.user.id);
    try {
      const { count } = writeFanoutFile({
        sharedDir,
        ingestKey,
        ownCastStreamKey,
        destinations: mine,
      });
      return res.json({ ok: true, destinationsArmed: count, ingestKey });
    } catch (err) {
      console.error('vcpeer-live: failed to write fanout file:', err.message);
      return res.status(500).json({ error: 'failed to arm destinations' });
    }
  });

  router.get('/status', (req, res) => {
    const data = store.get();
    let ingestKey;
    store.update((current) => {
      const result = getOrCreateIngestKey(current, req.user.id);
      ingestKey = result.key;
      return result.data;
    });
    const status = readFanoutStatus({ sharedDir, ingestKey });
    return res.json(status);
  });

  return router;
}

module.exports = { buildLiveRouter };
