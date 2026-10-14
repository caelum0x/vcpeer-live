'use strict';

const crypto = require('crypto');
const express = require('express');

const { requireAuth } = require('../lib/auth');
const { validateDestination } = require('../lib/validate');
const { encryptStreamKey, maskStreamKey } = require('../lib/crypto');

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
    // We only have ciphertext here; mask using a fixed-length placeholder
    // derived from stored metadata length rather than decrypting just to mask.
    const result = mine.map((d) => ({
      id: d.id,
      platform: d.platform,
      label: d.label,
      rtmpUrl: d.rtmpUrl,
      enabled: d.enabled,
      streamKeyMasked: '*'.repeat(8),
      createdAt: d.createdAt,
    }));
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
    return res.json(toPublicDestination(merged, req.body.streamKey));
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
