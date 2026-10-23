'use strict';

const express = require('express');

const { requireAuth } = require('../lib/auth');
const {
  getOrCreateIngestKey,
  regenerateIngestKey,
  writeFanoutFile,
  readFanoutStatus,
  removeFanoutArtifacts,
  writeRecordFlag,
  removeRecordFlag,
} = require('../lib/live');
const { startBroadcast, stopBroadcast } = require('../lib/broadcasts');
const { effectiveOwnerId } = require('../lib/team');
const { getPlan, PRO_PLAN } = require('../lib/billing');

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
    const ownerId = effectiveOwnerId(store.get(), req.user.id);
    let ingestKey;
    store.update((data) => {
      const result = getOrCreateIngestKey(data, ownerId);
      ingestKey = result.key;
      return result.data;
    });
    return res.json(credentialsFor(ingestKey));
  });

  // Rotates the signed-in user's ingest key - the only credential a
  // leaked RTMP/WHIP URL exposes - and deletes any already-armed
  // fanout config on disk for the old key so it stops working
  // immediately, not just once the user re-arms with the new one. A
  // team member rotates the OWNER's key (same one everyone on the team
  // streams through), not a key of their own.
  router.post('/credentials/regenerate', (req, res) => {
    const ownerId = effectiveOwnerId(store.get(), req.user.id);
    let oldKey;
    let newKey;
    store.update((data) => {
      const result = regenerateIngestKey(data, ownerId);
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
    const ownerId = effectiveOwnerId(data, req.user.id);
    let ingestKey;
    store.update((current) => {
      const result = getOrCreateIngestKey(current, ownerId);
      ingestKey = result.key;
      return result.data;
    });

    const mine = data.destinations.filter((d) => d.userId === ownerId);
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
      // broadcast into several history rows. Keyed by `ownerId`, not the
      // signed-in user, so a team member going live shows up in - and
      // shares - the owner's one broadcast history, not a second history
      // of their own.
      let broadcast;
      store.update((current) => {
        const result = startBroadcast(current, { userId: ownerId, ingestKey, destinationsArmed: armedCount });
        broadcast = result.broadcast;
        return result.data;
      });
      // VOD recording (Pro only, see lib/live.js writeRecordFlag) - armed
      // by broadcast id so fanout.sh's recording leg writes a file
      // routes/vods.js can match straight back to this history row.
      // Always re-evaluated on every go-live, not just the first one, so
      // a subscription that lapsed between broadcasts stops recording
      // immediately rather than on some separate cleanup pass.
      if (getPlan(data, ownerId) === PRO_PLAN) {
        writeRecordFlag({ sharedDir, ingestKey, broadcastId: broadcast.id });
      } else {
        removeRecordFlag({ sharedDir, ingestKey });
      }
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
    const ownerId = effectiveOwnerId(data, req.user.id);
    const keyEntry = data.ingestKeys.find((k) => k.userId === ownerId);
    const destinationsSnapshot = keyEntry
      ? readFanoutStatus({ sharedDir, ingestKey: keyEntry.key }).destinations
      : [];
    let broadcast = null;
    store.update((current) => {
      const result = stopBroadcast(current, ownerId, { destinationsSnapshot });
      broadcast = result.broadcast;
      return result.data;
    });
    if (!broadcast) {
      return res.json({ ok: true, broadcast: null, message: 'no open broadcast to stop' });
    }
    return res.json({ ok: true, broadcast });
  });

  router.get('/status', (req, res) => {
    const ownerId = effectiveOwnerId(store.get(), req.user.id);
    let ingestKey;
    store.update((current) => {
      const result = getOrCreateIngestKey(current, ownerId);
      ingestKey = result.key;
      return result.data;
    });
    const status = readFanoutStatus({ sharedDir, ingestKey });
    return res.json(status);
  });

  return router;
}

module.exports = { buildLiveRouter };
