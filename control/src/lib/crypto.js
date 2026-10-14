'use strict';

const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

/**
 * Loads the 32-byte encryption key from the environment.
 * Fails fast if missing or the wrong length - a secret this sensitive
 * must never silently fall back to a default.
 */
function loadKey(rawHexKey) {
  const hex = rawHexKey || process.env.ENCRYPTION_KEY;
  if (!hex) {
    throw new Error('ENCRYPTION_KEY is not set');
  }
  const key = Buffer.from(hex, 'hex');
  if (key.length !== 32) {
    throw new Error('ENCRYPTION_KEY must be a 64-character hex string (32 bytes)');
  }
  return key;
}

/**
 * Encrypts a plaintext stream key. Returns a new object - never mutates
 * input - containing the pieces needed to decrypt later. Safe to store
 * at rest (e.g. in the destinations JSON store).
 */
function encryptStreamKey(plaintext, rawHexKey) {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new Error('plaintext stream key must be a non-empty string');
  }
  const key = loadKey(rawHexKey);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    iv: iv.toString('hex'),
    authTag: authTag.toString('hex'),
    data: encrypted.toString('hex'),
  };
}

/**
 * Decrypts a stream key produced by encryptStreamKey. Throws (does not
 * silently return garbage) if the ciphertext or tag has been tampered with.
 */
function decryptStreamKey(encrypted, rawHexKey) {
  if (!encrypted || !encrypted.iv || !encrypted.authTag || !encrypted.data) {
    throw new Error('invalid encrypted stream key payload');
  }
  const key = loadKey(rawHexKey);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(encrypted.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(encrypted.authTag, 'hex'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encrypted.data, 'hex')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}

/** Masks a stream key for display/logging: shows only the last 4 chars. */
function maskStreamKey(plaintext) {
  if (!plaintext || plaintext.length <= 4) return '****';
  return `${'*'.repeat(Math.max(plaintext.length - 4, 4))}${plaintext.slice(-4)}`;
}

module.exports = { encryptStreamKey, decryptStreamKey, maskStreamKey };
