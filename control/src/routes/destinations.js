'use strict';

const crypto = require('crypto');
const express = require('express');

const { requireAuth } = require('../lib/auth');
const { validateDestination } = require('../lib/validate');
const { encryptStreamKey, decryptStreamKey, maskStreamKey } = require('../lib/crypto');

function toPublicDestination(dest, plainKeyForMasking) {
  // Never return the encrypted payload or any derivable secret - only a
  // masked preview (last 4 chars), same as what the owner sees in any
  // other credential manager.
  return {
    id: dest.id,
    platform: dest.platform,
    label: dest.label,
    rtmpUrl: dest.rtmpUrl,
    enabled: dest.enabled,
    streamKeyMasked: maskStreamKey(plainKeyForMasking),
    createdAt: dest.createdAt,
  };
}

function buildDestinationsRouter(store) {
  const router = express.Router();
  router.use(requireAuth(store));

  router.get('/', (req, res) => {
    const data = store.get();
    const mine = data.destinations.filter((d) => d.userId === req.user.id);
    // Decrypt only to build the last-4-chars mask (never returned, never
    // logged) - a fixed-length placeholder for every row would make every
    // destination look identical on reload, defeating the point of
    // showing a mask at all (the user can no longer tell which stored key
    // is which). AES-256-GCM decrypt of a handful of short strings per
    // request is negligible cost.
    const result = mine.map((d) => {
      let plainKeyForMasking = null;
      try {
        plainKeyForMasking = decryptStreamKey(d.encryptedKey);
      } catch (err) {
        console.error('vcpeer-live: failed to decrypt destination key for masking:', err.message);
      }
      return toPublicDestination(d, plainKeyForMasking);
    });
    return res.json({ destinations: result });
  });

  router.post('/', (req, res) => {
    const { valid, errors } = validateDestination(req.body);
    if (!valid) return res.status(400).json({ errors });

    const encryptedKey = encryptStreamKey(req.body.streamKey.trim());
    const dest = {
      id: crypto.randomUUID(),
      userId: req.user.id,
      platform: req.body.platform,
      label: req.body.label.trim(),
      rtmpUrl: req.body.rtmpUrl.trim(),
      encryptedKey,
      enabled: true,
      createdAt: new Date().toISOString(),
    };
    store.update((data) => ({ ...data, destinations: [...data.destinations, dest] }));
    return res.status(201).json(toPublicDestination(dest, req.body.streamKey));
  });

  router.put('/:id', (req, res) => {
    const data = store.get();
    const existing = data.destinations.find((d) => d.id === req.params.id && d.userId === req.user.id);
    if (!existing) return res.status(404).json({ error: 'destination not found' });

    const patch = {};
    if (typeof req.body.enabled === 'boolean') patch.enabled = req.body.enabled;
    if (typeof req.body.label === 'string' && req.body.label.trim()) patch.label = req.body.label.trim();
    if (typeof req.body.rtmpUrl === 'string' && req.body.rtmpUrl.trim()) patch.rtmpUrl = req.body.rtmpUrl.trim();
    if (typeof req.body.streamKey === 'string' && req.body.streamKey.trim()) {
      patch.encryptedKey = encryptStreamKey(req.body.streamKey.trim());
    }

    const merged = { ...existing, ...patch };
    const { valid, errors } = validateDestination({
      platform: merged.platform,
      label: merged.label,
      rtmpUrl: merged.rtmpUrl,
      streamKey: req.body.streamKey || 'unchanged-placeholder-ok',
    });
    if (!valid) return res.status(400).json({ errors });

    store.update((d) => ({
      ...d,
      destinations: d.destinations.map((dest) => (dest.id === merged.id ? merged : dest)),
    }));

    // If this request didn't include a new streamKey, mask from the
    // (unchanged) stored ciphertext rather than passing `undefined`
    // through to the mask helper, which would otherwise show a blank
    // '****' placeholder for a key that never actually changed.
    let plainKeyForMasking = req.body.streamKey;
    if (!plainKeyForMasking) {
      try {
        plainKeyForMasking = decryptStreamKey(merged.encryptedKey);
      } catch (err) {
        console.error('vcpeer-live: failed to decrypt destination key for masking:', err.message);
      }
    }
    return res.json(toPublicDestination(merged, plainKeyForMasking));
  });

  router.delete('/:id', (req, res) => {
    const data = store.get();
    const existing = data.destinations.find((d) => d.id === req.params.id && d.userId === req.user.id);
    if (!existing) return res.status(404).json({ error: 'destination not found' });
    store.update((d) => ({ ...d, destinations: d.destinations.filter((dest) => dest.id !== req.params.id) }));
    return res.status(204).end();
  });

  return router;
}

module.exports = { buildDestinationsRouter, toPublicDestination };
