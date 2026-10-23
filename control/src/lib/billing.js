'use strict';

const FREE_PLAN = 'free';
const PRO_PLAN = 'pro';

/** Returns a user's plan, defaulting to free for any user created before this field existed. */
function getPlan(data, userId) {
  const user = data.users.find((u) => u.id === userId);
  return (user && user.plan) || FREE_PLAN;
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
