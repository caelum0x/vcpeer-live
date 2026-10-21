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
 * Each line: platform|label|host:port-free-rtmp-url-with-key
 * The decrypted destination stream key is appended to the URL here, in
 * memory, right before writing the file - never logged, never returned
 * to any HTTP response.
 */
function writeFanoutFile({ sharedDir, ingestKey, ownCastStreamKey, destinations, encryptionKey }) {
  const lines = [`owncast|Owncast|rtmp://owncast:1935/live/${ownCastStreamKey}`];
  let armedCount = 0;
  for (const dest of destinations) {
    if (!dest.enabled) continue;
    const plainKey = decryptStreamKey(dest.encryptedKey, encryptionKey);
    const base = dest.rtmpUrl.endsWith('/') ? dest.rtmpUrl.slice(0, -1) : dest.rtmpUrl;
    lines.push(`${dest.platform}|${dest.label}|${base}/${plainKey}`);
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

/** Reads MediaMTX's status file (written by fanout.sh) for a given ingest key, if present. */
function readFanoutStatus({ sharedDir, ingestKey }) {
  const file = path.join(sharedDir, `${ingestKey}.status`);
  if (!fs.existsSync(file)) return { live: false, destinations: [] };
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { live: false, destinations: [] };
  }
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
