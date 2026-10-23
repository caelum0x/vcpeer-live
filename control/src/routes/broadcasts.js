'use strict';

const express = require('express');

const { requireAuth } = require('../lib/auth');
const { listBroadcasts } = require('../lib/broadcasts');
const { effectiveOwnerId } = require('../lib/team');

/**
 * Read-only broadcast history: GET /api/broadcasts. Writes happen as a
 * side effect of POST /api/live/go (start) and POST /api/live/stop
 * (close) in routes/live.js - this router only ever reads. Keyed by
 * `effectiveOwnerId` so a team member sees - and shares - the owner's
 * history, same as destinations and the ingest key.
 */
function buildBroadcastsRouter(store) {
  const router = express.Router();
  router.use(requireAuth(store));

  router.get('/', (req, res) => {
    const data = store.get();
    const broadcasts = listBroadcasts(data, effectiveOwnerId(data, req.user.id));
    const totalMs = broadcasts.reduce((sum, b) => sum + (b.durationMs || 0), 0);
    return res.json({ broadcasts, totalHours: totalMs / (1000 * 60 * 60) });
  });

  return router;
}

module.exports = { buildBroadcastsRouter };
