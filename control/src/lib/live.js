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

module.exports = { getOrCreateIngestKey, writeFanoutFile, readFanoutStatus };
