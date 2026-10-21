'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  getOrCreateIngestKey,
  regenerateIngestKey,
  removeFanoutArtifacts,
} = require('../src/lib/live');

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
