'use strict';

const express = require('express');

const { requireAuth } = require('../lib/auth');
const {
  getOrCreateIngestKey,
  regenerateIngestKey,
  writeFanoutFile,
  readFanoutStatus,
  removeFanoutArtifacts,
} = require('../lib/live');

function buildLiveRouter(store, { rtmpPublicUrl, whipPublicUrl, sharedDir, ownCastStreamKey }) {
  const router = express.Router();
  router.use(requireAuth(store));

  function credentialsFor(ingestKey) {
    return {
      rtmpUrl: `${rtmpPublicUrl}/live/${ingestKey}`,
      whipUrl: `${whipPublicUrl}/live/${ingestKey}/whip`,
      watchUrl: `${process.env.OWNCAST_PUBLIC_URL || 'http://localhost:8080'}`,
    };
  }

  router.get('/credentials', (req, res) => {
    let ingestKey;
    store.update((data) => {
      const result = getOrCreateIngestKey(data, req.user.id);
      ingestKey = result.key;
      return result.data;
    });
    return res.json(credentialsFor(ingestKey));
  });

  // Rotates the signed-in user's ingest key - the only credential a
  // leaked RTMP/WHIP URL exposes - and deletes any already-armed
  // fanout config on disk for the old key so it stops working
  // immediately, not just once the user re-arms with the new one.
  router.post('/credentials/regenerate', (req, res) => {
    let oldKey;
    let newKey;
    store.update((data) => {
      const result = regenerateIngestKey(data, req.user.id);
      oldKey = result.oldKey;
      newKey = result.newKey;
      return result.data;
    });
    try {
      if (oldKey) removeFanoutArtifacts({ sharedDir, ingestKey: oldKey });
    } catch (err) {
      console.error('vcpeer-live: failed to clean up old ingest key artifacts:', err.message);
    }
    return res.json(credentialsFor(newKey));
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
      const { armedCount } = writeFanoutFile({
        sharedDir,
        ingestKey,
        ownCastStreamKey,
        destinations: mine,
      });
      return res.json({ ok: true, destinationsArmed: armedCount, ingestKey });
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
