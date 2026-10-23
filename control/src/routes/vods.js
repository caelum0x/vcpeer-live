'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');

const { requireAuth } = require('../lib/auth');
const { listBroadcasts } = require('../lib/broadcasts');
const { effectiveOwnerId } = require('../lib/team');
const { getPlan, PRO_PLAN } = require('../lib/billing');
const { listVodSegments, deleteVodSegments } = require('../lib/live');
const { signVodToken, verifyVodToken } = require('../lib/crypto');

// Long enough to start playback or a download; short enough that a URL
// copied out of a network tab or a chat log is useless within the hour.
const URL_TTL_MS = 15 * 60 * 1000;

function signedUrl({ publicUrl, ingestKey, broadcastId, segment }) {
  const exp = Date.now() + URL_TTL_MS;
  const token = signVodToken({ ingestKey, broadcastId, segment, exp });
  return `${publicUrl}/vods/${ingestKey}/${broadcastId}/${segment}?exp=${exp}&token=${token}`;
}

function requirePro(data, ownerId, res) {
  if (getPlan(data, ownerId) === PRO_PLAN) return null;
  res.status(403).json({ error: 'Recording your streams is a Pro feature.' });
  return true;
}

/**
 * VOD recording (Pro-only - see lib/live.js writeRecordFlag + the
 * recording leg mediamtx/scripts/fanout.sh starts) - lists/deletes a
 * user's own recorded segments and mints short-lived signed download
 * URLs (lib/crypto.js signVodToken) for the separate, session-free
 * streaming route below (buildVodStreamRouter). Every recording is keyed
 * by `effectiveOwnerId`, same as destinations and broadcast history, so
 * a team member sees - and can play back - the owner's recordings too.
 */
function buildVodsRouter(store, { sharedDir, publicUrl }) {
  const router = express.Router();
  router.use(requireAuth(store));

  function ownerIngestKey(data, ownerId) {
    const entry = data.ingestKeys.find((k) => k.userId === ownerId);
    return entry ? entry.key : null;
  }

  router.get('/', (req, res) => {
    const data = store.get();
    const ownerId = effectiveOwnerId(data, req.user.id);
    if (requirePro(data, ownerId, res)) return;
    const ingestKey = ownerIngestKey(data, ownerId);
    if (!ingestKey) return res.json({ recordings: [] });

    const recordings = listBroadcasts(data, ownerId)
      .filter((b) => b.endedAt)
      .map((b) => {
        const segments = listVodSegments({ sharedDir, ingestKey, broadcastId: b.id });
        if (!segments.length) return null;
        return {
          broadcastId: b.id,
          startedAt: b.startedAt,
          endedAt: b.endedAt,
          durationMs: b.durationMs,
          sizeBytes: segments.reduce((sum, s) => sum + s.sizeBytes, 0),
          segments: segments.map((s) => ({
            segment: s.segment,
            sizeBytes: s.sizeBytes,
            url: signedUrl({ publicUrl, ingestKey, broadcastId: b.id, segment: s.segment }),
          })),
        };
      })
      .filter(Boolean);
    return res.json({ recordings });
  });

  // Mints a fresh short-lived URL for one segment - lets a page that has
  // been open past URL_TTL_MS keep playing without re-fetching the whole
  // list.
  router.get('/:broadcastId/segments/:segment/url', (req, res) => {
    const data = store.get();
    const ownerId = effectiveOwnerId(data, req.user.id);
    if (requirePro(data, ownerId, res)) return;
    const ingestKey = ownerIngestKey(data, ownerId);
    const segment = Number(req.params.segment);
    if (!ingestKey || !Number.isInteger(segment) || segment < 1) {
      return res.status(404).json({ error: 'recording not found' });
    }
    const segments = listVodSegments({ sharedDir, ingestKey, broadcastId: req.params.broadcastId });
    if (!segments.some((s) => s.segment === segment)) return res.status(404).json({ error: 'recording not found' });
    return res.json({ url: signedUrl({ publicUrl, ingestKey, broadcastId: req.params.broadcastId, segment }) });
  });

  // Deleting your own recordings is always allowed, even off Pro -
  // reclaiming disk from a recording made during an earlier Pro period
  // is reasonable self-service; only LISTING/STREAMING is Pro-gated.
  router.delete('/:broadcastId', (req, res) => {
    const data = store.get();
    const ownerId = effectiveOwnerId(data, req.user.id);
    const ingestKey = ownerIngestKey(data, ownerId);
    if (!ingestKey) return res.status(404).json({ error: 'recording not found' });
    const removed = deleteVodSegments({ sharedDir, ingestKey, broadcastId: req.params.broadcastId });
    if (!removed) return res.status(404).json({ error: 'recording not found' });
    return res.status(204).end();
  });

  return router;
}

const INGEST_KEY_PATTERN = /^[a-f0-9]{24}$/;
const BROADCAST_ID_PATTERN = /^[0-9a-f-]{36}$/;
const SEGMENT_PATTERN = /^\d+$/;
const RANGE_PATTERN = /^bytes=(\d*)-(\d*)$/;

/**
 * Public, session-free streaming/download route for one recorded
 * segment - deliberately NOT behind requireAuth, so a recording can be
 * played from a plain <video> tag or shared as a link, same as any
 * other VOD host. Access control is the short-lived HMAC token from
 * buildVodsRouter above instead of a cookie. Every path component is
 * validated against a strict pattern before touching the filesystem,
 * independent of (and before) token verification, so a malformed id
 * can never reach `path.join` even if the token check below ever had a
 * bug.
 */
function buildVodStreamRouter({ sharedDir }) {
  const router = express.Router();

  router.get('/:ingestKey/:broadcastId/:segment', (req, res) => {
    const { ingestKey, broadcastId, segment } = req.params;
    if (
      !INGEST_KEY_PATTERN.test(ingestKey) ||
      !BROADCAST_ID_PATTERN.test(broadcastId) ||
      !SEGMENT_PATTERN.test(segment)
    ) {
      return res.status(400).json({ error: 'invalid recording reference' });
    }
    const { exp, token } = req.query;
    if (!verifyVodToken({ ingestKey, broadcastId, segment, exp, token })) {
      return res.status(401).json({ error: 'invalid or expired link' });
    }

    const file = path.join(sharedDir, 'vods', ingestKey, `${broadcastId}.${segment}.mp4`);
    if (!fs.existsSync(file)) return res.status(404).json({ error: 'recording not found' });
    const stat = fs.statSync(file);

    const range = req.headers.range;
    if (!range) {
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': stat.size, 'Accept-Ranges': 'bytes' });
      fs.createReadStream(file).pipe(res);
      return;
    }
    const match = RANGE_PATTERN.exec(range);
    if (!match) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
      return res.end();
    }
    const start = match[1] ? parseInt(match[1], 10) : 0;
    const end = match[2] ? parseInt(match[2], 10) : stat.size - 1;
    if (start > end || end >= stat.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
      return res.end();
    }
    res.writeHead(206, {
      'Content-Type': 'video/mp4',
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Content-Length': end - start + 1,
      'Accept-Ranges': 'bytes',
    });
    fs.createReadStream(file, { start, end }).pipe(res);
  });

  return router;
}

module.exports = { buildVodsRouter, buildVodStreamRouter };
