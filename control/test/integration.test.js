'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.ENCRYPTION_KEY = 'c'.repeat(64);
process.env.VCPEER_LIVE_ENV = 'dev';

const { createApp } = require('../src/server');
const { createRateLimiter } = require('../src/lib/rateLimit');

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function withServer(fn, appOverrides = {}) {
  const dataDir = tempDir('vcpeer-live-data-');
  const sharedDir = tempDir('vcpeer-live-shared-');
  const { app } = createApp({
    dataFile: path.join(dataDir, 'db.json'),
    sharedDir,
    publicUrl: 'http://localhost:0',
    ownCastStreamKey: 'owncast-test-key',
    ...appOverrides,
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  try {
    await fn(base, sharedDir);
  } finally {
    server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(sharedDir, { recursive: true, force: true });
  }
}

async function signIn(base) {
  const requestRes = await fetch(`${base}/api/auth/request-link`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'owner@vcpeer.com' }),
  });
  const requestBody = await requestRes.json();
  assert.equal(requestRes.status, 200);
  assert.ok(requestBody.devLink, 'dev mode should echo the magic link when SMTP is unset');

  const token = new URL(requestBody.devLink).searchParams.get('token');
  const callbackRes = await fetch(`${base}/api/auth/callback?token=${token}`, { redirect: 'manual' });
  assert.equal(callbackRes.status, 302);
  const setCookie = callbackRes.headers.get('set-cookie');
  assert.ok(setCookie && setCookie.includes('vcpeer_live_session='));
  return setCookie.split(';')[0];
}

test('unauthenticated requests to protected routes are rejected', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/destinations`);
    assert.equal(res.status, 401);
  });
});

test('magic link sign-in issues a session cookie that unlocks the dashboard APIs', async () => {
  await withServer(async (base) => {
    const cookie = await signIn(base);
    const res = await fetch(`${base}/api/me`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.email, 'owner@vcpeer.com');
  });
});

test('a reused/expired magic-link token is rejected', async () => {
  await withServer(async (base) => {
    const requestRes = await fetch(`${base}/api/auth/request-link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'owner@vcpeer.com' }),
    });
    const { devLink } = await requestRes.json();
    const token = new URL(devLink).searchParams.get('token');

    const first = await fetch(`${base}/api/auth/callback?token=${token}`, { redirect: 'manual' });
    assert.equal(first.status, 302);

    const second = await fetch(`${base}/api/auth/callback?token=${token}`, { redirect: 'manual' });
    assert.equal(second.status, 400);
  });
});

test('logging out revokes the session server-side, not just the cookie on the client', async () => {
  await withServer(async (base) => {
    const cookie = await signIn(base);

    const beforeLogout = await fetch(`${base}/api/me`, { headers: { Cookie: cookie } });
    assert.equal(beforeLogout.status, 200);

    const logoutRes = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { Cookie: cookie } });
    assert.equal(logoutRes.status, 200);

    // A copy of the old cookie (e.g. leaked, synced, or read from a shared
    // machine before logout) must stop working - the server must have
    // actually revoked the session, not just told the browser to clear it.
    const afterLogout = await fetch(`${base}/api/me`, { headers: { Cookie: cookie } });
    assert.equal(afterLogout.status, 401);
  });
});

test('adding a destination never returns the plaintext stream key, and rejects invalid input', async () => {
  await withServer(async (base) => {
    const cookie = await signIn(base);

    const badRes = await fetch(`${base}/api/destinations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ platform: 'twitch', label: '', rtmpUrl: 'http://nope', streamKey: '' }),
    });
    assert.equal(badRes.status, 400);

    const goodRes = await fetch(`${base}/api/destinations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        platform: 'twitch',
        label: 'My Twitch',
        rtmpUrl: 'rtmp://live.twitch.tv/app',
        streamKey: 'super_secret_twitch_key',
      }),
    });
    assert.equal(goodRes.status, 201);
    const created = await goodRes.json();
    const serialized = JSON.stringify(created);
    assert.ok(!serialized.includes('super_secret_twitch_key'));
    assert.ok(created.streamKeyMasked.endsWith('_key'));

    const listRes = await fetch(`${base}/api/destinations`, { headers: { Cookie: cookie } });
    const list = await listRes.json();
    assert.equal(list.destinations.length, 1);
    assert.ok(!JSON.stringify(list).includes('super_secret_twitch_key'));
  });
});

test('go-live writes a fanout file with the owncast target and only enabled, decrypted destinations', async () => {
  await withServer(async (base, sharedDir) => {
    const cookie = await signIn(base);

    await fetch(`${base}/api/destinations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        platform: 'custom',
        label: 'Fake Twitch (local)',
        rtmpUrl: 'rtmp://mediamtx-fake:1935/twitch',
        streamKey: 'fake-twitch-key-123',
      }),
    });
    const disabledRes = await fetch(`${base}/api/destinations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        platform: 'custom',
        label: 'Disabled target',
        rtmpUrl: 'rtmp://mediamtx-fake:1935/kick',
        streamKey: 'should-not-appear',
      }),
    });
    const disabled = await disabledRes.json();
    await fetch(`${base}/api/destinations/${disabled.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ enabled: false }),
    });

    const goRes = await fetch(`${base}/api/live/go`, { method: 'POST', headers: { Cookie: cookie } });
    assert.equal(goRes.status, 200);
    const goBody = await goRes.json();
    assert.equal(goBody.destinationsArmed, 1); // Owncast is always armed and must not be counted; only the one enabled custom destination is

    const files = fs.readdirSync(sharedDir).filter((f) => f.endsWith('.destinations'));
    assert.equal(files.length, 1);
    const contents = fs.readFileSync(path.join(sharedDir, files[0]), 'utf8');
    assert.ok(contents.includes('rtmp://owncast:1935/live/owncast-test-key'));
    assert.ok(contents.includes('fake-twitch-key-123'));
    assert.ok(!contents.includes('should-not-appear'));
  });
});

test('listing destinations shows each one\'s real last-4 key mask, not an identical placeholder', async () => {
  await withServer(async (base) => {
    const cookie = await signIn(base);

    await fetch(`${base}/api/destinations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        platform: 'twitch',
        label: 'My Twitch',
        rtmpUrl: 'rtmp://live.twitch.tv/app',
        streamKey: 'twitch_secret_aaaa',
      }),
    });
    await fetch(`${base}/api/destinations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        platform: 'kick',
        label: 'My Kick',
        rtmpUrl: 'rtmp://fa723fc1b171.global-contribute.kick.com/app',
        streamKey: 'kick_secret_bbbb',
      }),
    });

    const listRes = await fetch(`${base}/api/destinations`, { headers: { Cookie: cookie } });
    assert.equal(listRes.status, 200);
    const { destinations } = await listRes.json();
    assert.equal(destinations.length, 2);

    const serialized = JSON.stringify(destinations);
    assert.ok(!serialized.includes('twitch_secret_aaaa'));
    assert.ok(!serialized.includes('kick_secret_bbbb'));

    const twitch = destinations.find((d) => d.platform === 'twitch');
    const kick = destinations.find((d) => d.platform === 'kick');
    // Each destination's own real key must be distinguishable on reload -
    // a fixed "********" placeholder for every row defeats the purpose of
    // showing a mask at all (can't tell which stored key is which).
    assert.ok(twitch.streamKeyMasked.endsWith('aaaa'));
    assert.ok(kick.streamKeyMasked.endsWith('bbbb'));
    assert.notEqual(twitch.streamKeyMasked, kick.streamKeyMasked);
  });
});

test('updating a destination without changing its key still returns the real mask, not a blank placeholder', async () => {
  await withServer(async (base) => {
    const cookie = await signIn(base);

    const createRes = await fetch(`${base}/api/destinations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        platform: 'twitch',
        label: 'My Twitch',
        rtmpUrl: 'rtmp://live.twitch.tv/app',
        streamKey: 'twitch_secret_cccc',
      }),
    });
    const created = await createRes.json();
    assert.ok(created.streamKeyMasked.endsWith('cccc'));

    // Rename only - streamKey is intentionally omitted from this request.
    const renameRes = await fetch(`${base}/api/destinations/${created.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ label: 'My Twitch (renamed)' }),
    });
    assert.equal(renameRes.status, 200);
    const renamed = await renameRes.json();
    assert.equal(renamed.label, 'My Twitch (renamed)');
    assert.ok(renamed.streamKeyMasked.endsWith('cccc'));
  });
});

test('sign-in requests are rate limited per email to stop mail-bombing a target address', async () => {
  const authRateLimiters = {
    perIp: createRateLimiter({ windowMs: 60_000, max: 100 }),
    perEmail: createRateLimiter({ windowMs: 60_000, max: 2 }),
  };
  await withServer(
    async (base) => {
      const body = JSON.stringify({ email: 'victim@vcpeer.com' });
      const headers = { 'Content-Type': 'application/json' };

      const first = await fetch(`${base}/api/auth/request-link`, { method: 'POST', headers, body });
      assert.equal(first.status, 200);
      const second = await fetch(`${base}/api/auth/request-link`, { method: 'POST', headers, body });
      assert.equal(second.status, 200);

      const third = await fetch(`${base}/api/auth/request-link`, { method: 'POST', headers, body });
      assert.equal(third.status, 429);
      assert.ok(third.headers.get('retry-after'));
      const thirdBody = await third.json();
      assert.ok(!thirdBody.devLink, 'a rate-limited response must never issue/echo a new link');
    },
    { authRateLimiters }
  );
});

test('sign-in rate limits are scoped per email, not a global lockout for everyone', async () => {
  const authRateLimiters = {
    perIp: createRateLimiter({ windowMs: 60_000, max: 100 }),
    perEmail: createRateLimiter({ windowMs: 60_000, max: 1 }),
  };
  await withServer(
    async (base) => {
      const headers = { 'Content-Type': 'application/json' };
      const first = await fetch(`${base}/api/auth/request-link`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ email: 'one@vcpeer.com' }),
      });
      assert.equal(first.status, 200);

      const other = await fetch(`${base}/api/auth/request-link`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ email: 'two@vcpeer.com' }),
      });
      assert.equal(other.status, 200);
    },
    { authRateLimiters }
  );
});

test('destination lifecycle: toggle and delete', async () => {
  await withServer(async (base) => {
    const cookie = await signIn(base);
    const createRes = await fetch(`${base}/api/destinations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        platform: 'kick',
        label: 'My Kick',
        rtmpUrl: 'rtmp://fa723fc1b171.global-contribute.kick.com/app',
        streamKey: 'kick-key',
      }),
    });
    assert.equal(createRes.status, 201);
    const created = await createRes.json();
    assert.equal(created.enabled, true);

    const toggleRes = await fetch(`${base}/api/destinations/${created.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal((await toggleRes.json()).enabled, false);

    const deleteRes = await fetch(`${base}/api/destinations/${created.id}`, {
      method: 'DELETE',
      headers: { Cookie: cookie },
    });
    assert.equal(deleteRes.status, 204);

    const listRes = await fetch(`${base}/api/destinations`, { headers: { Cookie: cookie } });
    assert.equal((await listRes.json()).destinations.length, 0);
  });
});
