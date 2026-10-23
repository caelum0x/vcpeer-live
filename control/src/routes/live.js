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
const { startBroadcast, stopBroadcast } = require('../lib/broadcasts');

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
      // Appends a broadcast-history start record every time destinations
      // are (re-)armed. A destination toggle mid-broadcast also calls
      // this same underlying writeFanoutFile path via reArmIfLive in
      // routes/destinations.js, but NOT through this route - only an
      // explicit POST /api/live/go (OBS "Arm destinations" or the browser
      // go-live button) starts a new history record, so toggling one
      // destination on/off while already live does not fragment a single
      // broadcast into several history rows.
      store.update((current) => startBroadcast(current, { userId: req.user.id, ingestKey, destinationsArmed: armedCount }).data);
      return res.json({ ok: true, destinationsArmed: armedCount, ingestKey });
    } catch (err) {
      console.error('vcpeer-live: failed to write fanout file:', err.message);
      return res.status(500).json({ error: 'failed to arm destinations' });
    }
  });

  // There is no reliable server-side signal for "the broadcaster is done"
  // short of MediaMTX's runOnUnavailable hook flipping `.status` to
  // offline (which already happens automatically when the RTMP/WHIP
  // source disconnects) - this route is the explicit bookkeeping close
  // for broadcast HISTORY, called when the user clicks "I'm done" in the
  // dashboard. It snapshots each destination's final status (from
  // item 1's per-destination state files) into the history record before
  // it closes, and is a safe no-op if nothing was open.
  router.post('/stop', (req, res) => {
    const data = store.get();
    const keyEntry = data.ingestKeys.find((k) => k.userId === req.user.id);
    const destinationsSnapshot = keyEntry
      ? readFanoutStatus({ sharedDir, ingestKey: keyEntry.key }).destinations
      : [];
    let broadcast = null;
    store.update((current) => {
      const result = stopBroadcast(current, req.user.id, { destinationsSnapshot });
      broadcast = result.broadcast;
      return result.data;
    });
    if (!broadcast) {
      return res.json({ ok: true, broadcast: null, message: 'no open broadcast to stop' });
    }
    return res.json({ ok: true, broadcast });
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
