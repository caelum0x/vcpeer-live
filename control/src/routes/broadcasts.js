'use strict';

const express = require('express');

const { requireAuth } = require('../lib/auth');
const { listBroadcasts } = require('../lib/broadcasts');

/**
 * Read-only broadcast history: GET /api/broadcasts. Writes happen as a
 * side effect of POST /api/live/go (start) and POST /api/live/stop
 * (close) in routes/live.js - this router only ever reads.
 */
function buildBroadcastsRouter(store) {
  const router = express.Router();
  router.use(requireAuth(store));

  router.get('/', (req, res) => {
    const broadcasts = listBroadcasts(store.get(), req.user.id);
    const totalMs = broadcasts.reduce((sum, b) => sum + (b.durationMs || 0), 0);
    return res.json({ broadcasts, totalHours: totalMs / (1000 * 60 * 60) });
  });

  return router;
}

module.exports = { buildBroadcastsRouter };
