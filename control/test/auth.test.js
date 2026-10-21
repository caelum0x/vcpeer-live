'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { requestMagicLink, consumeMagicLink, resolveSession, revokeSession } = require('../src/lib/auth');

function emptyStore() {
  return { users: [], magicLinks: [], sessions: [], destinations: [], ingestKeys: [] };
}

test('requestMagicLink creates a user and an unused link, without mutating the input', () => {
  const store = emptyStore();
  const frozen = JSON.parse(JSON.stringify(store));
  const { data, token, user } = requestMagicLink(store, 'owner@vcpeer.com');

  assert.deepEqual(store, frozen, 'input store object must not be mutated');
  assert.equal(data.users.length, 1);
  assert.equal(data.magicLinks.length, 1);
  assert.equal(data.magicLinks[0].used, false);
  assert.equal(user.email, 'owner@vcpeer.com');
  assert.equal(typeof token, 'string');
  assert.ok(token.length >= 32);
});

test('requestMagicLink reuses the same user on a second request', () => {
  const store = emptyStore();
  const first = requestMagicLink(store, 'owner@vcpeer.com');
  const second = requestMagicLink(first.data, 'owner@vcpeer.com');
  assert.equal(second.data.users.length, 1);
  assert.equal(second.data.magicLinks.length, 2);
});

test('consumeMagicLink exchanges a valid token for a session', () => {
  const store = emptyStore();
  const { data, token } = requestMagicLink(store, 'owner@vcpeer.com');
  const result = consumeMagicLink(data, token);

  assert.equal(result.ok, true);
  assert.equal(result.data.sessions.length, 1);
  assert.equal(result.data.magicLinks[0].used, true);
});

test('consumeMagicLink rejects an unknown token', () => {
  const store = emptyStore();
  const result = consumeMagicLink(store, 'does-not-exist');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not_found');
});

test('consumeMagicLink rejects a token used twice', () => {
  const store = emptyStore();
  const { data, token } = requestMagicLink(store, 'owner@vcpeer.com');
  const first = consumeMagicLink(data, token);
  const second = consumeMagicLink(first.data, token);
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'already_used');
});

test('consumeMagicLink rejects an expired token', () => {
  const store = emptyStore();
  const { data, token } = requestMagicLink(store, 'owner@vcpeer.com');
  const expired = {
    ...data,
    magicLinks: data.magicLinks.map((l) => (l.token === token ? { ...l, expiresAt: Date.now() - 1000 } : l)),
  };
  const result = consumeMagicLink(expired, token);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'expired');
});

test('resolveSession returns the user for a valid, unexpired session', () => {
  const store = emptyStore();
  const { data, token } = requestMagicLink(store, 'owner@vcpeer.com');
  const consumed = consumeMagicLink(data, token);
  const user = resolveSession(consumed.data, consumed.session.token);
  assert.equal(user.email, 'owner@vcpeer.com');
});

test('resolveSession returns null for an unknown session token', () => {
  const store = emptyStore();
  assert.equal(resolveSession(store, 'nope'), null);
  assert.equal(resolveSession(store, undefined), null);
});

test('resolveSession returns null for an expired session', () => {
  const store = emptyStore();
  const { data, token } = requestMagicLink(store, 'owner@vcpeer.com');
  const consumed = consumeMagicLink(data, token);
  const expiredStore = {
    ...consumed.data,
    sessions: consumed.data.sessions.map((s) => ({ ...s, expiresAt: Date.now() - 1 })),
  };
  assert.equal(resolveSession(expiredStore, consumed.session.token), null);
});

test('revokeSession removes the matching session without mutating the input, and leaves others intact', () => {
  const store = emptyStore();
  // Build a store with two independent sessions for two different users.
  const reqA = requestMagicLink(store, 'a@vcpeer.com');
  const afterA = consumeMagicLink(reqA.data, reqA.token);
  const reqB = requestMagicLink(afterA.data, 'b@vcpeer.com');
  const afterB = consumeMagicLink(reqB.data, reqB.token);

  const frozen = JSON.parse(JSON.stringify(afterB.data));
  const next = revokeSession(afterB.data, afterA.session.token);

  assert.deepEqual(afterB.data, frozen, 'input store object must not be mutated');
  assert.equal(resolveSession(next, afterA.session.token), null, 'revoked session must stop resolving');
  assert.ok(resolveSession(next, afterB.session.token), 'the other session must be untouched');
});

test('revokeSession is a no-op (returns an equivalent store) for an unknown token', () => {
  const store = emptyStore();
  const { data, token } = requestMagicLink(store, 'owner@vcpeer.com');
  const consumed = consumeMagicLink(data, token);
  const next = revokeSession(consumed.data, 'does-not-exist');
  assert.deepEqual(next, consumed.data);
});
