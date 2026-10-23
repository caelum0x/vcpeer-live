'use strict';

/**
 * Twitch Helix OAuth - exchanges an authorization code for a token, then
 * fetches the broadcaster's raw RTMP stream key so the "Connect Twitch"
 * button in the dashboard can auto-fill the add-destination form instead
 * of the user copy-pasting it from Twitch's own dashboard.
 *
 * Needs a free Twitch Developer Console app registration (owner-only
 * step - console.twitch.tv/console/apps - takes ~2 minutes, zero cost) to
 * get a real TWITCH_CLIENT_ID/TWITCH_CLIENT_SECRET. Until that's done,
 * `isConfigured()` is false and routes/oauth.js returns a clear 501
 * instead of a broken redirect - the manual "paste your RTMP URL and
 * key" form on the dashboard keeps working either way, this is strictly
 * an added convenience layer on top of it.
 *
 * The stream key scope (`channel:read:stream_key`) is the one Twitch
 * scope that can read this value at all - it is never requested for any
 * other purpose, and the token itself is discarded immediately after
 * this one read (see routes/oauth.js's pending-credential cache) - never
 * stored, never refreshed, never used again.
 */

const AUTHORIZE_URL = 'https://id.twitch.tv/oauth2/authorize';
const TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
const HELIX_BASE = 'https://api.twitch.tv/helix';
const SCOPE = 'channel:read:stream_key';

function isConfigured() {
  return Boolean(process.env.TWITCH_CLIENT_ID && process.env.TWITCH_CLIENT_SECRET);
}

/** Builds the URL to send the user's browser to for the Twitch consent screen. */
function buildAuthorizeUrl({ redirectUri, state }) {
  const params = new URLSearchParams({
    client_id: process.env.TWITCH_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPE,
    state,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

/** Exchanges the callback's `code` for a short-lived Helix access token. */
async function exchangeCodeForToken({ code, redirectUri }) {
  const params = new URLSearchParams({
    client_id: process.env.TWITCH_CLIENT_ID,
    client_secret: process.env.TWITCH_CLIENT_SECRET,
    code,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
  });
  const res = await fetch(TOKEN_URL, { method: 'POST', body: params });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Twitch token exchange failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const json = await res.json();
  return { accessToken: json.access_token };
}

function helixHeaders(accessToken) {
  return {
    Authorization: `Bearer ${accessToken}`,
    'Client-Id': process.env.TWITCH_CLIENT_ID,
  };
}

/** Resolves the authenticated token's own Twitch user (broadcaster) id. */
async function getBroadcasterId(accessToken) {
  const res = await fetch(`${HELIX_BASE}/users`, { headers: helixHeaders(accessToken) });
  if (!res.ok) throw new Error(`Twitch /users lookup failed (${res.status})`);
  const json = await res.json();
  const user = json.data && json.data[0];
  if (!user) throw new Error('Twitch /users returned no user for this token');
  return user.id;
}

/**
 * Fetches the broadcaster's current raw RTMP stream key via Helix's
 * `GET /streams/key` (requires `channel:read:stream_key`). This is the
 * one piece OBS-style setup normally requires copy-pasting by hand.
 */
async function getStreamKey(accessToken, broadcasterId) {
  const url = `${HELIX_BASE}/streams/key?broadcaster_id=${encodeURIComponent(broadcasterId)}`;
  const res = await fetch(url, { headers: helixHeaders(accessToken) });
  if (!res.ok) throw new Error(`Twitch /streams/key lookup failed (${res.status})`);
  const json = await res.json();
  const entry = json.data && json.data[0];
  if (!entry || !entry.stream_key) throw new Error('Twitch /streams/key returned no key');
  return entry.stream_key;
}

/**
 * Runs the full post-callback flow: code -> token -> broadcaster id ->
 * stream key -> the exact {rtmpUrl, streamKey} shape the add-destination
 * form needs. `rtmp://live.twitch.tv/app` is Twitch's one standard
 * ingest URL for every broadcaster (no per-user variation), so it is a
 * constant here, not something fetched from the API.
 */
async function fetchDestinationCredentials({ code, redirectUri }) {
  const { accessToken } = await exchangeCodeForToken({ code, redirectUri });
  const broadcasterId = await getBroadcasterId(accessToken);
  const streamKey = await getStreamKey(accessToken, broadcasterId);
  return { platform: 'twitch', rtmpUrl: 'rtmp://live.twitch.tv/app', streamKey };
}

module.exports = {
  isConfigured,
  buildAuthorizeUrl,
  exchangeCodeForToken,
  getBroadcasterId,
  getStreamKey,
  fetchDestinationCredentials,
};
