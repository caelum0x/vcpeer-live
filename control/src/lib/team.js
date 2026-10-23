'use strict';

const crypto = require('crypto');

const { getPlan, PRO_PLAN } = require('./billing');

// Beyond the owner's own seat. Small on purpose - this is "one show, a
// couple of co-operators", not a full org-chart feature.
const MAX_TEAM_SEATS = 3;
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function membershipOf(data, userId) {
  return (data.teamMembers || []).find((m) => m.memberUserId === userId) || null;
}

function membersOf(data, ownerId) {
  return (data.teamMembers || []).filter((m) => m.ownerId === ownerId);
}

function pendingInvites(data, ownerId) {
  const now = Date.now();
  return (data.teamInvites || []).filter((i) => i.ownerId === ownerId && !i.acceptedAt && i.expiresAt > now);
}

/**
 * Resolves whose destinations / ingest key / broadcast history `userId`
 * should act on: their own account, unless they are an accepted member
 * of a team whose owner is CURRENTLY on Pro. This is checked live
 * against the owner's plan on every call rather than cached on the
 * membership row, so an owner who lets Pro lapse immediately drops every
 * member back to their own (empty) account - no separate cleanup job,
 * no stale shared access.
 */
function effectiveOwnerId(data, userId) {
  const membership = membershipOf(data, userId);
  if (!membership) return userId;
  if (getPlan(data, membership.ownerId) !== PRO_PLAN) return userId;
  return membership.ownerId;
}

/**
 * Creates a pending invite for `email` under `ownerId`. Returns
 * `{ data, invite }` on success or `{ error }` on failure, never
 * mutating `data` - every caller gets the same Pro-only, seat-limited
 * gate because it lives here, not duplicated in the route.
 */
function createInvite(data, ownerId, email) {
  if (getPlan(data, ownerId) !== PRO_PLAN) {
    return { error: 'Team seats are a Pro feature.' };
  }
  const seatsUsed = membersOf(data, ownerId).length + pendingInvites(data, ownerId).length;
  if (seatsUsed >= MAX_TEAM_SEATS) {
    return { error: `Your team is at its ${MAX_TEAM_SEATS}-seat limit.` };
  }
  const alreadyMember = membersOf(data, ownerId).some((m) => {
    const user = data.users.find((u) => u.id === m.memberUserId);
    return user && user.email === email;
  });
  if (alreadyMember) {
    return { error: 'That email is already on your team.' };
  }
  const alreadyInvited = pendingInvites(data, ownerId).some((i) => i.email === email);
  if (alreadyInvited) {
    return { error: 'That email already has a pending invite.' };
  }

  const invite = {
    id: crypto.randomUUID(),
    ownerId,
    email,
    token: crypto.randomBytes(24).toString('hex'),
    createdAt: new Date().toISOString(),
    expiresAt: Date.now() + INVITE_TTL_MS,
    acceptedAt: null,
  };
  return { data: { ...data, teamInvites: [...(data.teamInvites || []), invite] }, invite };
}

/**
 * Consumes an invite token for the now-signed-in `userId` accepting it.
 * A user can only ever be on one team at a time - accepting a second
 * invite silently replaces the first membership rather than stacking.
 * Returns `{ data, membership }` or `{ error }`.
 */
function acceptInvite(data, token, userId) {
  const invite = (data.teamInvites || []).find((i) => i.token === token);
  if (!invite) return { error: 'Invite not found.' };
  if (invite.acceptedAt) return { error: 'This invite has already been used.' };
  if (invite.expiresAt <= Date.now()) return { error: 'This invite has expired.' };
  if (invite.ownerId === userId) return { error: 'You cannot join your own team.' };

  const withoutPriorMembership = (data.teamMembers || []).filter((m) => m.memberUserId !== userId);
  const membership = { ownerId: invite.ownerId, memberUserId: userId, joinedAt: new Date().toISOString() };
  const nextInvites = (data.teamInvites || []).map((i) =>
    i.token === token ? { ...i, acceptedAt: new Date().toISOString() } : i
  );
  return {
    data: { ...data, teamInvites: nextInvites, teamMembers: [...withoutPriorMembership, membership] },
    membership,
  };
}

/** Owner-initiated removal of one member. Returns `{ data, removed }` - `removed: false` is a safe no-op, never a throw. */
function removeMember(data, ownerId, memberUserId) {
  const before = (data.teamMembers || []).length;
  const next = (data.teamMembers || []).filter((m) => !(m.ownerId === ownerId && m.memberUserId === memberUserId));
  return { data: { ...data, teamMembers: next }, removed: next.length !== before };
}

/** Self-initiated departure - a member leaving someone else's team, regardless of who the owner is. */
function leaveTeam(data, memberUserId) {
  const before = (data.teamMembers || []).length;
  const next = (data.teamMembers || []).filter((m) => m.memberUserId !== memberUserId);
  return { data: { ...data, teamMembers: next }, left: next.length !== before };
}

function revokeInvite(data, ownerId, inviteId) {
  const before = (data.teamInvites || []).length;
  const next = (data.teamInvites || []).filter((i) => !(i.ownerId === ownerId && i.id === inviteId));
  return { data: { ...data, teamInvites: next }, removed: next.length !== before };
}

module.exports = {
  MAX_TEAM_SEATS,
  membershipOf,
  membersOf,
  pendingInvites,
  effectiveOwnerId,
  createInvite,
  acceptInvite,
  removeMember,
  leaveTeam,
  revokeInvite,
};
