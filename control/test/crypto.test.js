'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { encryptStreamKey, decryptStreamKey, maskStreamKey } = require('../src/lib/crypto');

const TEST_KEY = 'a'.repeat(64); // 32 bytes hex

test('encryptStreamKey/decryptStreamKey round-trip', () => {
  const plaintext = 'live_super_secret_stream_key_123';
  const encrypted = encryptStreamKey(plaintext, TEST_KEY);
  assert.notEqual(encrypted.data, plaintext);
  assert.ok(encrypted.iv && encrypted.authTag && encrypted.data);
  const decrypted = decryptStreamKey(encrypted, TEST_KEY);
  assert.equal(decrypted, plaintext);
});

test('encryptStreamKey never leaks plaintext into the ciphertext fields', () => {
  const plaintext = 'twitch_live_abcDEF123456';
  const encrypted = encryptStreamKey(plaintext, TEST_KEY);
  const serialized = JSON.stringify(encrypted);
  assert.ok(!serialized.includes(plaintext));
});

test('decryptStreamKey rejects a tampered ciphertext (auth tag fails)', () => {
  const encrypted = encryptStreamKey('some_key', TEST_KEY);
  const tampered = { ...encrypted, data: encrypted.data.slice(0, -2) + 'ff' };
  assert.throws(() => decryptStreamKey(tampered, TEST_KEY));
});

test('decryptStreamKey rejects a wrong key', () => {
  const encrypted = encryptStreamKey('some_key', TEST_KEY);
  const otherKey = 'b'.repeat(64);
  assert.throws(() => decryptStreamKey(encrypted, otherKey));
});

test('encryptStreamKey throws on empty plaintext', () => {
  assert.throws(() => encryptStreamKey('', TEST_KEY));
});

test('encryptStreamKey throws if ENCRYPTION_KEY missing/invalid length', () => {
  assert.throws(() => encryptStreamKey('abc', 'tooshort'));
  const original = process.env.ENCRYPTION_KEY;
  delete process.env.ENCRYPTION_KEY;
  assert.throws(() => encryptStreamKey('abc'));
  if (original) process.env.ENCRYPTION_KEY = original;
});

test('maskStreamKey only reveals the last 4 characters', () => {
  const masked = maskStreamKey('abcdefgh1234');
  assert.equal(masked.slice(-4), '1234');
  assert.ok(!masked.includes('abcdefgh'));
});

test('maskStreamKey handles short/empty input without throwing', () => {
  assert.equal(maskStreamKey(''), '****');
  assert.equal(maskStreamKey('ab'), '****');
});
