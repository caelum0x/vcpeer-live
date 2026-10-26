'use strict';

const FREE_PLAN = 'free';
const PRO_PLAN = 'pro';

/**
 * VCPeer Live is free for everyone (owner decision 2026-10-27: VCPeer is
 * off the paid server, no more billing). Every user's effective plan is
 * Pro - unlimited destinations, VOD recording, and team seats - with no
 * checkout required. `data`/`userId` are kept as parameters (unused) so
 * every call site above this function (team.js, vods.js, live.js,
 * routes/billing.js) is unchanged; this is the one place that grants
 * full access.
 */
function getPlan(_data, _userId) {
  return PRO_PLAN;
}

/**
 * Returns a safe-to-display billing summary for one user, or null if the
 * user id doesn't exist. Never includes anything beyond what the
 * dashboard needs - no raw Dodo payloads.
 */
function getBillingProfile(data, userId) {
  const user = data.users.find((u) => u.id === userId);
  if (!user) return null;
  return {
    plan: user.plan || FREE_PLAN,
    dodoCustomerId: user.dodoCustomerId || null,
    dodoSubscriptionId: user.dodoSubscriptionId || null,
    proSince: user.proSince || null,
  };
}

/** Immutably patches one user's billing fields. No-op (equivalent store) if the id doesn't match anyone. */
function patchUserBilling(data, userId, patch) {
  return {
    ...data,
    users: data.users.map((u) => (u.id === userId ? { ...u, ...patch } : u)),
  };
}

module.exports = { FREE_PLAN, PRO_PLAN, getPlan, getBillingProfile, patchUserBilling };
