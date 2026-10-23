'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'e'.repeat(64);

const {
  getOrCreateIngestKey,
  regenerateIngestKey,
  removeFanoutArtifacts,
  writeFanoutFile,
  readFanoutStatus,
} = require('../src/lib/live');
const { encryptStreamKey } = require('../src/lib/crypto');

function emptyStore() {
  return { users: [], magicLinks: [], sessions: [], destinations: [], ingestKeys: [] };
}

test('regenerateIngestKey replaces an existing key with a new, different one', () => {
  const data = emptyStore();
  const { data: withKey, key: oldKey } = getOrCreateIngestKey(data, 'user-1');

  const { data: rotated, oldKey: removedKey, newKey } = regenerateIngestKey(withKey, 'user-1');

  assert.equal(removedKey, oldKey);
  assert.notEqual(newKey, oldKey);
  assert.equal(rotated.ingestKeys.filter((k) => k.userId === 'user-1').length, 1);
  assert.equal(rotated.ingestKeys.find((k) => k.userId === 'user-1').key, newKey);
});

test('regenerateIngestKey does not mutate the input store object', () => {
  const data = emptyStore();
  const { data: withKey } = getOrCreateIngestKey(data, 'user-1');
  const before = JSON.parse(JSON.stringify(withKey));

  regenerateIngestKey(withKey, 'user-1');

  assert.deepEqual(withKey, before);
});

test('regenerateIngestKey issues a first key for a user who never had one', () => {
  const data = emptyStore();
  const { data: rotated, oldKey, newKey } = regenerateIngestKey(data, 'user-1');
  assert.equal(oldKey, null);
  assert.ok(newKey);
  assert.equal(rotated.ingestKeys.find((k) => k.userId === 'user-1').key, newKey);
});

test('regenerateIngestKey only touches the requesting user\'s key, not other users\'', () => {
  const data = emptyStore();
  const { data: withBoth } = getOrCreateIngestKey(getOrCreateIngestKey(data, 'user-1').data, 'user-2');
  const user2KeyBefore = withBoth.ingestKeys.find((k) => k.userId === 'user-2').key;

  const { data: rotated } = regenerateIngestKey(withBoth, 'user-1');

  assert.equal(rotated.ingestKeys.find((k) => k.userId === 'user-2').key, user2KeyBefore);
});

test('removeFanoutArtifacts deletes every file for an ingest key and nothing else', () => {
  const sharedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcpeer-live-shared-'));
  try {
    const keyA = 'aaaaaaaaaaaaaaaaaaaaaaaa';
    const keyB = 'bbbbbbbbbbbbbbbbbbbbbbbb';
    fs.writeFileSync(path.join(sharedDir, `${keyA}.destinations`), 'owncast|Owncast|rtmp://x\n');
    fs.writeFileSync(path.join(sharedDir, `${keyA}.status`), '{"live":true}');
    fs.writeFileSync(path.join(sharedDir, `${keyA}.pids`), '1234\n');
    fs.writeFileSync(path.join(sharedDir, `${keyA}.twitch.log`), 'log');
    fs.writeFileSync(path.join(sharedDir, `${keyB}.destinations`), 'owncast|Owncast|rtmp://y\n');

    removeFanoutArtifacts({ sharedDir, ingestKey: keyA });

    const remaining = fs.readdirSync(sharedDir).sort();
    assert.deepEqual(remaining, [`${keyB}.destinations`]);
  } finally {
    fs.rmSync(sharedDir, { recursive: true, force: true });
  }
});

test('removeFanoutArtifacts is a no-op when the shared dir does not exist', () => {
  assert.doesNotThrow(() => removeFanoutArtifacts({ sharedDir: '/tmp/vcpeer-live-never-exists-xyz', ingestKey: 'abc' }));
});

test('writeFanoutFile keys each line by destination id, not just platform, so two same-platform destinations do not collide', () => {
  const sharedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcpeer-live-shared-'));
  try {
    const destinations = [
      {
        id: 'dest-a',
        platform: 'twitch',
        label: 'Main Twitch',
        rtmpUrl: 'rtmp://live.twitch.tv/app',
        enabled: true,
        encryptedKey: encryptStreamKey('key-a'),
      },
      {
        id: 'dest-b',
        platform: 'twitch',
        label: 'Backup Twitch',
        rtmpUrl: 'rtmp://live.twitch.tv/app',
        enabled: true,
        encryptedKey: encryptStreamKey('key-b'),
      },
    ];

    const { file, armedCount } = writeFanoutFile({
      sharedDir,
      ingestKey: 'ingest-1',
      ownCastStreamKey: 'owncast-key',
      destinations,
    });

    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    assert.equal(armedCount, 2);
    assert.equal(lines[0], 'owncast|owncast|Owncast|rtmp://owncast:1935/live/owncast-key');
    assert.equal(lines[1], 'dest-a|twitch|Main Twitch|rtmp://live.twitch.tv/app/key-a');
    assert.equal(lines[2], 'dest-b|twitch|Backup Twitch|rtmp://live.twitch.tv/app/key-b');
  } finally {
    fs.rmSync(sharedDir, { recursive: true, force: true });
  }
});

test('readFanoutStatus reports live flag from .status and per-destination health from .state files, excluding owncast', () => {
  const sharedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcpeer-live-shared-'));
  try {
    const ingestKey = 'ingest-2';
    fs.writeFileSync(
      path.join(sharedDir, `${ingestKey}.status`),
      JSON.stringify({ live: true, startedAt: '2026-10-23T00:00:00Z' })
    );
    fs.writeFileSync(
      path.join(sharedDir, `${ingestKey}.owncast.state`),
      JSON.stringify({ id: 'owncast', platform: 'owncast', label: 'Owncast', state: 'pushing', attempt: 1 })
    );
    fs.writeFileSync(
      path.join(sharedDir, `${ingestKey}.dest-a.state`),
      JSON.stringify({ id: 'dest-a', platform: 'twitch', label: 'Main Twitch', state: 'pushing', attempt: 1, lastError: null })
    );
    fs.writeFileSync(
      path.join(sharedDir, `${ingestKey}.dest-b.state`),
      JSON.stringify({ id: 'dest-b', platform: 'kick', label: 'Backup Kick', state: 'failed', attempt: 8, lastError: 'failed after 8 attempts' })
    );

    const status = readFanoutStatus({ sharedDir, ingestKey });

    assert.equal(status.live, true);
    assert.equal(status.startedAt, '2026-10-23T00:00:00Z');
    assert.equal(status.destinations.length, 2);
    assert.ok(!status.destinations.some((d) => d.id === 'owncast'));
    const kick = status.destinations.find((d) => d.id === 'dest-b');
    assert.equal(kick.state, 'failed');
    assert.equal(kick.lastError, 'failed after 8 attempts');
  } finally {
    fs.rmSync(sharedDir, { recursive: true, force: true });
  }
});

test('readFanoutStatus defaults to offline with no destinations when nothing has been written yet', () => {
  const sharedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcpeer-live-shared-'));
  try {
    const status = readFanoutStatus({ sharedDir, ingestKey: 'never-went-live' });
    assert.equal(status.live, false);
    assert.deepEqual(status.destinations, []);
  } finally {
    fs.rmSync(sharedDir, { recursive: true, force: true });
  }
});

test('readFanoutStatus skips a .state file that is mid-write/corrupt instead of throwing', () => {
  const sharedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcpeer-live-shared-'));
  try {
    const ingestKey = 'ingest-3';
    fs.writeFileSync(path.join(sharedDir, `${ingestKey}.status`), JSON.stringify({ live: true }));
    fs.writeFileSync(path.join(sharedDir, `${ingestKey}.dest-a.state`), '{"id":"dest-a","platform":"twitch"'); // truncated
    fs.writeFileSync(
      path.join(sharedDir, `${ingestKey}.dest-b.state`),
      JSON.stringify({ id: 'dest-b', platform: 'kick', label: 'Kick', state: 'pushing', attempt: 1 })
    );

    const status = readFanoutStatus({ sharedDir, ingestKey });

    assert.equal(status.destinations.length, 1);
    assert.equal(status.destinations[0].id, 'dest-b');
  } finally {
    fs.rmSync(sharedDir, { recursive: true, force: true });
  }
});
