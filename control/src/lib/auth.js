'use strict';

const crypto = require('crypto');

const MAGIC_LINK_TTL_MS = 15 * 60 * 1000; // 15 minutes
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

function findOrCreateUser(data, email) {
  const existing = data.users.find((u) => u.email === email);
  if (existing) return { data, user: existing };
  const user = { id: crypto.randomUUID(), email, createdAt: new Date().toISOString() };
  return { data: { ...data, users: [...data.users, user] }, user };
}

/**
 * Starts a magic-link sign-in. Returns the new store state and the raw
 * token (caller is responsible for emailing it - never log the token
 * itself, only that a link was requested).
 */
function requestMagicLink(data, email) {
  const { data: withUser, user } = findOrCreateUser(data, email);
  const token = newToken();
  const link = {
    token,
    userId: user.id,
    email,
    expiresAt: Date.now() + MAGIC_LINK_TTL_MS,
    used: false,
  };
  const next = { ...withUser, magicLinks: [...withUser.magicLinks, link] };
  return { data: next, token, user };
}

/**
 * Consumes a magic-link token. Returns { ok: true, data, session } or
 * { ok: false, reason } without mutating the input store object.
 */
function consumeMagicLink(data, token) {
  const link = data.magicLinks.find((l) => l.token === token);
  if (!link) return { ok: false, reason: 'not_found' };
  if (link.used) return { ok: false, reason: 'already_used' };
  if (Date.now() > link.expiresAt) return { ok: false, reason: 'expired' };

  const sessionToken = newToken();
  const session = {
    token: sessionToken,
    userId: link.userId,
    createdAt: new Date().toISOString(),
    expiresAt: Date.now() + SESSION_TTL_MS,
  };

  const nextLinks = data.magicLinks.map((l) => (l.token === token ? { ...l, used: true } : l));
  const next = { ...data, magicLinks: nextLinks, sessions: [...data.sessions, session] };
  return { ok: true, data: next, session };
}

/**
 * Revokes a session server-side (e.g. on logout). Returns a NEW store
 * object with the matching session removed - a no-op (equivalent store)
 * if the token doesn't match any session. Clearing the cookie alone is
 * not enough: a copy of the old cookie value (leaked, synced, or read
 * from a shared machine before logout) must stop being accepted too.
 */
function revokeSession(data, sessionToken) {
  return { ...data, sessions: data.sessions.filter((s) => s.token !== sessionToken) };
}

/**
 * Derives a stable, non-reversible identifier for a session from its raw
 * token - used so GET /api/auth/sessions can list and target individual
 * sessions for remote revocation without ever sending the raw session
 * token (a live bearer credential) back down to the browser. SHA-256 of
 * the token, truncated to 16 hex chars, is plenty of entropy to avoid
 * collisions across one user's handful of sessions while being useless on
 * its own for re-authenticating.
 */
function sessionId(sessionToken) {
  return crypto.createHash('sha256').update(sessionToken).digest('hex').slice(0, 16);
}

/**
 * Lists a user's active (non-expired) sessions as safe-to-display
 * summaries - never the raw token. `currentSessionToken` (the requester's
 * own cookie) is used only to flag which row is "this device" in the UI;
 * it is never itself returned.
 */
function listSessions(data, userId, currentSessionToken) {
  const now = Date.now();
  return data.sessions
    .filter((s) => s.userId === userId && s.expiresAt > now)
    .map((s) => ({
      id: sessionId(s.token),
      createdAt: s.createdAt || null,
      expiresAt: new Date(s.expiresAt).toISOString(),
      current: s.token === currentSessionToken,
    }))
    .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
}

/**
 * Revokes one specific session by its derived id (see sessionId above),
 * scoped to the requesting user so one account can never revoke another
 * account's session even if it somehow guessed an id. Returns a NEW store
 * object; a no-op (equivalent store) if no session matches - the caller
 * decides whether that is a 404.
 */
function revokeSessionById(data, userId, targetSessionId) {
  return {
    ...data,
    sessions: data.sessions.filter((s) => !(s.userId === userId && sessionId(s.token) === targetSessionId)),
  };
}

/** Resolves a session token to a user, or null if invalid/expired. */
function resolveSession(data, sessionToken) {
  if (!sessionToken) return null;
  const session = data.sessions.find((s) => s.token === sessionToken);
  if (!session) return null;
  if (Date.now() > session.expiresAt) return null;
  return data.users.find((u) => u.id === session.userId) || null;
}

function requireAuth(store) {
  return (req, res, next) => {
    const sessionToken = req.cookies && req.cookies.vcpeer_live_session;
    const user = resolveSession(store.get(), sessionToken);
    if (!user) {
      return res.status(401).json({ error: 'authentication required' });
    }
    req.user = user;
    return next();
  };
}

module.exports = {
  requestMagicLink,
  consumeMagicLink,
  resolveSession,
  revokeSession,
  revokeSessionById,
  listSessions,
  sessionId,
  requireAuth,
  MAGIC_LINK_TTL_MS,
  SESSION_TTL_MS,
};
