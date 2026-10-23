'use strict';

const crypto = require('crypto');

/**
 * Starts a new broadcast history record for `userId`. Defensively closes
 * any previously-open record for the same user first - a user who never
 * sent POST /api/live/stop for their last broadcast (closed the tab,
 * encoder crashed, box rebooted) should not leave an "open forever" row
 * sitting in their history; the next go-live is good evidence the
 * previous one has genuinely ended. Returns a NEW store object and the
 * created record - never mutates `data`.
 */
function startBroadcast(data, { userId, ingestKey, destinationsArmed }) {
  const now = new Date().toISOString();
  const closedPrior = (data.broadcasts || []).map((b) =>
    b.userId === userId && !b.endedAt
      ? { ...b, endedAt: now, destinationsSnapshot: b.destinationsSnapshot || [] }
      : b
  );
  const record = {
    id: crypto.randomUUID(),
    userId,
    ingestKey,
    destinationsArmed,
    startedAt: now,
    endedAt: null,
    destinationsSnapshot: null,
  };
  return { data: { ...data, broadcasts: [...closedPrior, record] }, broadcast: record };
}

/**
 * Closes the user's currently-open broadcast (if any), stamping the
 * final per-destination status snapshot (from readFanoutStatus at the
 * moment of stop) for display in history. A no-op (equivalent store,
 * `broadcast: null`) if the user has no open broadcast - stopping twice,
 * or stopping after fanout-stop.sh already flipped `.status` to offline
 * server-side on its own, must never throw.
 */
function stopBroadcast(data, userId, { destinationsSnapshot } = {}) {
  const now = new Date().toISOString();
  let closed = null;
  const next = (data.broadcasts || []).map((b) => {
    if (b.userId === userId && !b.endedAt) {
      closed = { ...b, endedAt: now, destinationsSnapshot: destinationsSnapshot || [] };
      return closed;
    }
    return b;
  });
  return { data: { ...data, broadcasts: next }, broadcast: closed };
}

/**
 * Lists a user's broadcast history, newest first, each annotated with a
 * computed `durationMs` (null while still open). This lib intentionally
 * does not own a specific display format (hours/minutes, etc.) - the
 * route/UI layer sums `durationMs` into whatever unit it wants to show.
 */
function listBroadcasts(data, userId) {
  return (data.broadcasts || [])
    .filter((b) => b.userId === userId)
    .map((b) => ({
      ...b,
      durationMs: b.endedAt ? new Date(b.endedAt).getTime() - new Date(b.startedAt).getTime() : null,
    }))
    .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
}

module.exports = { startBroadcast, stopBroadcast, listBroadcasts };
