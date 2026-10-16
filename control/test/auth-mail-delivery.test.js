'use strict';

// Regression coverage for a real production bug found 2026-10-17: the
// shared Scribase Mail SMTP relay vcpeer-live sends through hit its daily
// send quota, so magic-link emails stopped being delivered, but the
// /api/auth/request-link route kept returning its normal "Check your email
// for a sign-in link." success response regardless - visitors were told an
// email was coming that never arrived, with no way to know why. See
// src/routes/auth.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { buildAuthRouter } = require('../src/routes/auth');

function emptyStore() {
  let data = { users: [], magicLinks: [], sessions: [], destinations: [], ingestKeys: [] };
  return {
    update(fn) {
      data = fn(data);
      return data;
    },
    get() {
      return data;
    },
  };
}

async function withAuthApp({ isDev, sendMagicLinkEmail }, fn) {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', buildAuthRouter(emptyStore(), {
    publicUrl: 'http://localhost:0',
    isDev,
    sendMagicLinkEmail,
  }));
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

test('production: a failed send returns an honest error, not a false "check your email" success', async () => {
  await withAuthApp(
    { isDev: false, sendMagicLinkEmail: async () => ({ sent: false, reason: 'send_failed' }) },
    async (base) => {
      const res = await fetch(`${base}/api/auth/request-link`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'visitor@example.com' }),
      });
      const body = await res.json();

      assert.equal(res.status, 502);
      assert.equal(body.ok, false);
      assert.ok(body.error, 'must surface an error message');
      assert.ok(
        !body.error.includes('Check your email'),
        'must not claim an email was sent when it was not'
      );
      assert.equal(body.devLink, undefined, 'must never leak a token in production');
    }
  );
});

test('production: a successful send still returns the normal success message', async () => {
  await withAuthApp(
    { isDev: false, sendMagicLinkEmail: async () => ({ sent: true }) },
    async (base) => {
      const res = await fetch(`${base}/api/auth/request-link`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'visitor@example.com' }),
      });
      const body = await res.json();

      assert.equal(res.status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.message, 'Check your email for a sign-in link.');
      assert.equal(body.devLink, undefined);
    }
  );
});

test('dev mode: a failed send still echoes the link back (existing local-proof convenience)', async () => {
  await withAuthApp(
    { isDev: true, sendMagicLinkEmail: async () => ({ sent: false, reason: 'smtp_not_configured' }) },
    async (base) => {
      const res = await fetch(`${base}/api/auth/request-link`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'visitor@example.com' }),
      });
      const body = await res.json();

      assert.equal(res.status, 200);
      assert.equal(body.ok, true);
      assert.ok(body.devLink && body.devLink.includes('token='));
    }
  );
});
