'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { decryptStreamKey } = require('./crypto');

/** Returns the user's ingest key, creating one on first use. */
function getOrCreateIngestKey(data, userId) {
  const existing = data.ingestKeys.find((k) => k.userId === userId);
  if (existing) return { data, key: existing.key };
  const key = crypto.randomBytes(12).toString('hex');
  const next = { ...data, ingestKeys: [...data.ingestKeys, { userId, key }] };
  return { data: next, key };
}

/**
 * Replaces a user's ingest key with a freshly generated one. The ingest
 * key doubles as the only thing standing between "anyone who has it" and
 * "can publish to this user's armed destinations" - MediaMTX itself
 * accepts any RTMP/WHIP publish whose path matches `live/<anything>`; the
 * control app never validates publishers at connect time. If a key leaks
 * (shared on screen during an OBS setup stream, pasted somewhere public,
 * etc.) the user needs a way to invalidate it, same as rotating any other
 * exposed secret. Returns a NEW store object; never mutates the input.
 * `oldKey` is null (not an error) when the user never had one yet.
 */
function regenerateIngestKey(data, userId) {
  const existing = data.ingestKeys.find((k) => k.userId === userId);
  const newKey = crypto.randomBytes(12).toString('hex');
  const withoutOld = data.ingestKeys.filter((k) => k.userId !== userId);
  const next = { ...data, ingestKeys: [...withoutOld, { userId, key: newKey }] };
  return { data: next, oldKey: existing ? existing.key : null, newKey };
}

/**
 * Writes the fan-out instructions MediaMTX's runOnReady hook (fanout.sh)
 * reads when a user's stream goes live. Pipe-delimited, not JSON - the
 * MediaMTX container is minimal (ffmpeg added, no JSON tooling) and this
 * format is trivial to parse with `read -r` in a POSIX shell.
 *
 * Each line: id|platform|label|host:port-free-rtmp-url-with-key
 * `id` is `dest.id` (or the literal "owncast" for the always-on internal
 * push) and is what fanout.sh uses to name this destination's per-push
 * status file - platform alone is not unique (a user can have two Twitch
 * destinations), so keying status files by platform would let one
 * destination's state clobber another's.
 * The decrypted destination stream key is appended to the URL here, in
 * memory, right before writing the file - never logged, never returned
 * to any HTTP response.
 */
function writeFanoutFile({ sharedDir, ingestKey, ownCastStreamKey, destinations, encryptionKey }) {
  const lines = [`owncast|owncast|Owncast|rtmp://owncast:1935/live/${ownCastStreamKey}`];
  let armedCount = 0;
  for (const dest of destinations) {
    if (!dest.enabled) continue;
    const plainKey = decryptStreamKey(dest.encryptedKey, encryptionKey);
    const base = dest.rtmpUrl.endsWith('/') ? dest.rtmpUrl.slice(0, -1) : dest.rtmpUrl;
    lines.push(`${dest.id}|${dest.platform}|${dest.label}|${base}/${plainKey}`);
    armedCount += 1;
  }
  if (!fs.existsSync(sharedDir)) fs.mkdirSync(sharedDir, { recursive: true });
  const file = path.join(sharedDir, `${ingestKey}.destinations`);
  fs.writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o600 });
  // `armedCount` is the user's own configured destinations only - Owncast
  // is always armed and isn't something the user configured, so it must
  // never be counted in the number shown back to them (see routes/live.js).
  return { file, count: lines.length, armedCount };
}

/**
 * Reads MediaMTX's status file (written by fanout.sh/fanout-stop.sh) for
 * the overall live/offline flag, plus one per-destination health entry
 * per `<ingestKey>.<destinationId>.state` file fanout.sh writes on every
 * push state transition (pushing/retrying/failed/stopped). The internal
 * Owncast push (id "owncast") is never a user-configured destination, so
 * it is excluded from the returned list - same convention as
 * `armedCount` above.
 */
function readFanoutStatus({ sharedDir, ingestKey }) {
  const file = path.join(sharedDir, `${ingestKey}.status`);
  let base = { live: false };
  if (fs.existsSync(file)) {
    try {
      base = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      base = { live: false };
    }
  }
  const destinations = readDestinationStates({ sharedDir, ingestKey });
  return {
    live: Boolean(base.live),
    ...(base.startedAt ? { startedAt: base.startedAt } : {}),
    destinations,
  };
}

/**
 * Collects every `<ingestKey>.<destinationId>.state` file fanout.sh has
 * written for this broadcast. Each destination writes only its own file
 * (named by its unique id, never by platform), so there is no
 * cross-process write race to guard against here - a corrupt/mid-write
 * file is just skipped and picked up correctly on the next 5s poll.
 */
function readDestinationStates({ sharedDir, ingestKey }) {
  if (!fs.existsSync(sharedDir)) return [];
  const prefix = `${ingestKey}.`;
  const suffix = '.state';
  const entries = [];
  for (const name of fs.readdirSync(sharedDir)) {
    if (!name.startsWith(prefix) || !name.endsWith(suffix)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(sharedDir, name), 'utf8'));
      if (parsed.id === 'owncast') continue;
      entries.push(parsed);
    } catch {
      // Skip a file fanout.sh is mid-write on - the next poll re-reads it.
    }
  }
  return entries.sort((a, b) => (a.label > b.label ? 1 : a.label < b.label ? -1 : 0));
}

/**
 * Deletes every file fanout.sh/the control app ever wrote for a given
 * ingest key (the `.destinations` config, `.status`, `.pids`, and any
 * per-platform `.log` files) from the shared volume. Called after
 * rotating a key so a captured old key is fully dead - without this, a
 * key that was already armed (its `.destinations` file written by a
 * prior POST /api/live/go) would still work for fan-out purposes even
 * after the control app "forgot" it, since fanout.sh reads straight off
 * disk and never asks the control app whether a key is still current.
 * A no-op (not an error) if the shared dir or the files don't exist.
 */
function removeFanoutArtifacts({ sharedDir, ingestKey }) {
  if (!ingestKey || !fs.existsSync(sharedDir)) return;
  const prefix = `${ingestKey}.`;
  for (const name of fs.readdirSync(sharedDir)) {
    if (name.startsWith(prefix)) {
      fs.rmSync(path.join(sharedDir, name), { force: true });
    }
  }
}

module.exports = {
  getOrCreateIngestKey,
  regenerateIngestKey,
  writeFanoutFile,
  readFanoutStatus,
  removeFanoutArtifacts,
};
