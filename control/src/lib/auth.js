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
    expiresAt: Date.now() + SESSION_TTL_MS,
  };

  const nextLinks = data.magicLinks.map((l) => (l.token === token ? { ...l, used: true } : l));
  const next = { ...data, magicLinks: nextLinks, sessions: [...data.sessions, session] };
  return { ok: true, data: next, session };
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
  requireAuth,
  MAGIC_LINK_TTL_MS,
  SESSION_TTL_MS,
};
