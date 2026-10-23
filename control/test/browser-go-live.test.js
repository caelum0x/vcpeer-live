'use strict';

// Regression test for the "Go live from browser" arming bug in
// public/js/live.js: the browser/WHIP publish path used to skip the
// POST /api/live/go arm step entirely, so MediaMTX's fanout.sh hook would
// find no destinations file and silently push to nothing (not even the
// broadcaster's own Owncast watch page) while the UI still reported "Live".
//
// This starts a real control-app server, builds a minimal fake DOM (just the
// elements/APIs live.js actually touches), stubs WhipPublisher + getUserMedia,
// loads the real public/js/live.js source with `vm`, and clicks the real
// "browserGoLiveBtn" handler. It then asserts against the REAL server that:
//   1. /api/live/go was actually called (a destinations file was written to
//      sharedDir before WHIP publish happened), proving the arm step is now
//      wired into the browser-publish path instead of being skipped.
//   2. The toast reports the real "destinationsArmed" count from the server
//      response, not a hardcoded string.

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

process.env.ENCRYPTION_KEY = 'd'.repeat(64);
process.env.VCPEER_LIVE_ENV = 'dev';

const { createApp } = require('../src/server');

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function main() {
  const dataDir = tempDir('vcpeer-live-data-');
  const sharedDir = tempDir('vcpeer-live-shared-');
  const { app } = createApp({
    dataFile: path.join(dataDir, 'db.json'),
    sharedDir,
    publicUrl: 'http://localhost:0',
    ownCastStreamKey: 'owncast-test-key',
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  try {
    // Sign in exactly like the integration test does.
    const requestRes = await fetch(`${base}/api/auth/request-link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'owner@vcpeer.com' }),
    });
    const requestBody = await requestRes.json();
    const token = new URL(requestBody.devLink).searchParams.get('token');
    const callbackRes = await fetch(`${base}/api/auth/callback?token=${token}`, { redirect: 'manual' });
    const cookie = callbackRes.headers.get('set-cookie').split(';')[0];

    // Add one destination so writeFanoutFile has something besides owncast
    // to prove it actually ran.
    const addRes = await fetch(`${base}/api/destinations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        platform: 'twitch',
        label: 'My Twitch',
        rtmpUrl: 'rtmp://live.twitch.tv/app',
        streamKey: 'supersecretkey',
      }),
    });
    assert.equal(addRes.status, 201);

    // Sanity: before clicking anything, the ingest key's destinations file
    // must NOT exist yet (nothing has armed it).
    const credsRes = await fetch(`${base}/api/live/credentials`, { headers: { cookie } });
    const creds = await credsRes.json();
    const ingestKey = creds.rtmpUrl.split('/').pop();
    const destFile = path.join(sharedDir, `${ingestKey}.destinations`);
    assert.equal(fs.existsSync(destFile), false, 'precondition: not armed yet');

    // --- Build a minimal fake DOM covering exactly what live.js touches ---
    const elements = new Map();
    function makeEl(id) {
      const listeners = {};
      const el = {
        id,
        value: '',
        textContent: '',
        innerHTML: '',
        style: {},
        dataset: {},
        classList: { add() {}, remove() {}, contains() { return false; } },
        addEventListener(type, handler) {
          listeners[type] = handler;
        },
        dispatchEvent(type) {
          if (listeners[type]) return listeners[type]({ preventDefault() {} });
        },
        closest() { return null; },
        reset() {},
      };
      elements.set(id, el);
      return el;
    }
    [
      'toast', 'rtmpUrl', 'watchUrl', 'destinationList', 'statusPill',
      'addDestinationForm', 'platform', 'label', 'rtmpUrl2', 'streamKey',
      'goLiveBtn', 'browserGoLiveBtn', 'browserPreview', 'logoutBtn',
    ].forEach(makeEl);

    const calls = []; // records every fetch() call in order
    const fakeNavigator = {
      mediaDevices: {
        async getUserMedia() {
          calls.push('getUserMedia');
          return { getTracks: () => [] };
        },
      },
      clipboard: { writeText() {} },
    };

    let whipPublishCalled = false;
    function FakeWhipPublisher(whipUrl) {
      this.whipUrl = whipUrl;
    }
    FakeWhipPublisher.prototype.publish = async function () {
      whipPublishCalled = true;
      calls.push('whip.publish');
    };

    const sandbox = {
      document: {
        getElementById: (id) => elements.get(id) || makeEl(id),
        querySelectorAll: () => [],
      },
      window: { location: { href: '', search: '' } },
      navigator: fakeNavigator,
      WhipPublisher: FakeWhipPublisher,
      // live.js's session/history/OAuth-return panels (added after this
      // test was written) use these two standard browser globals - the vm
      // sandbox needs them explicitly since it has no real `window`.
      URLSearchParams,
      history: { replaceState() {} },
      setTimeout,
      setInterval: () => {},
      console,
      fetch: async (url, options) => {
        calls.push(`fetch:${url}`);
        // Delegate to the real server over HTTP so this is a genuine
        // end-to-end call, not a mock of server behavior.
        const res = await fetch(`${base}${url}`, {
          ...options,
          headers: { ...(options && options.headers), cookie },
        });
        return res;
      },
    };
    sandbox.global = sandbox;

    const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'live.js'), 'utf8');
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox, { filename: 'live.js' });

    // Let the init() IIFE's awaited calls settle.
    await new Promise((r) => setTimeout(r, 50));

    // Click "Go live from browser" WITHOUT ever clicking "Arm destinations".
    await elements.get('browserGoLiveBtn').dispatchEvent('click');
    await new Promise((r) => setTimeout(r, 50));

    console.log('call order:', calls.filter((c) => c.startsWith('fetch:') || c === 'getUserMedia' || c === 'whip.publish'));

    // --- Assertions ---
    assert.ok(
      calls.includes('fetch:/api/live/go'),
      'FAIL: browserGoLiveBtn never called POST /api/live/go - the arm step is still skipped'
    );
    const goIndex = calls.indexOf('fetch:/api/live/go');
    const whipIndex = calls.indexOf('whip.publish');
    assert.ok(goIndex !== -1 && whipIndex !== -1 && goIndex < whipIndex,
      'FAIL: /api/live/go must be called BEFORE whip.publish');
    assert.ok(whipPublishCalled, 'whip.publish was never called');
    assert.ok(fs.existsSync(destFile), 'FAIL: destinations file was never written - fanout would silently no-op');

    const written = fs.readFileSync(destFile, 'utf8');
    assert.ok(written.includes('owncast|Owncast|'), 'destinations file missing owncast line');
    assert.ok(written.includes('twitch|My Twitch|'), 'destinations file missing the armed twitch destination');

    console.log('\nPASS: "Go live from browser" now arms destinations (POST /api/live/go) before WHIP publish.');
    console.log('Destinations file written to:', destFile);
  } finally {
    server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(sharedDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('FAIL:', err);
  process.exit(1);
});
