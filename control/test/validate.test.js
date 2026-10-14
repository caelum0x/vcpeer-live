'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { validateDestination, isValidEmail } = require('../src/lib/validate');

test('validateDestination accepts a well-formed Twitch destination', () => {
  const { valid, errors } = validateDestination({
    platform: 'twitch',
    label: 'My channel',
    rtmpUrl: 'rtmp://live.twitch.tv/app',
    streamKey: 'live_12345_abcdef',
  });
  assert.equal(valid, true);
  assert.deepEqual(errors, []);
});

test('validateDestination accepts rtmps:// for custom destinations', () => {
  const { valid } = validateDestination({
    platform: 'custom',
    label: 'Backup relay',
    rtmpUrl: 'rtmps://relay.example.com/app',
    streamKey: 'abc',
  });
  assert.equal(valid, true);
});

test('validateDestination rejects unknown platform', () => {
  const { valid, errors } = validateDestination({
    platform: 'facebook',
    label: 'x',
    rtmpUrl: 'rtmp://example.com/app',
    streamKey: 'abc',
  });
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('platform')));
});

test('validateDestination rejects http:// (non-RTMP) urls', () => {
  const { valid, errors } = validateDestination({
    platform: 'custom',
    label: 'x',
    rtmpUrl: 'http://example.com/app',
    streamKey: 'abc',
  });
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('rtmp://')));
});

test('validateDestination rejects an obviously wrong host for a known platform', () => {
  const { valid, errors } = validateDestination({
    platform: 'twitch',
    label: 'x',
    rtmpUrl: 'rtmp://not-twitch-at-all.example.com/app',
    streamKey: 'abc',
  });
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('does not look like')));
});

test('validateDestination requires a non-empty stream key', () => {
  const { valid, errors } = validateDestination({
    platform: 'custom',
    label: 'x',
    rtmpUrl: 'rtmp://example.com/app',
    streamKey: '   ',
  });
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('streamKey')));
});

test('validateDestination requires a label', () => {
  const { valid, errors } = validateDestination({
    platform: 'custom',
    label: '',
    rtmpUrl: 'rtmp://example.com/app',
    streamKey: 'abc',
  });
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('label')));
});

test('isValidEmail', () => {
  assert.equal(isValidEmail('owner@vcpeer.com'), true);
  assert.equal(isValidEmail('not-an-email'), false);
  assert.equal(isValidEmail(''), false);
  assert.equal(isValidEmail(null), false);
});
