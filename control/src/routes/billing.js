'use strict';

const express = require('express');

const { requireAuth } = require('../lib/auth');
const dodo = require('../lib/dodo');
const { getBillingProfile, patchUserBilling, PRO_PLAN, FREE_PLAN } = require('../lib/billing');

const PRO_EVENTS = new Set(['subscription.active', 'subscription.renewed']);
const FREE_EVENTS = new Set(['subscription.cancelled', 'subscription.expired', 'subscription.failed']);

/**
 * Applies one verified Dodo webhook event to the store. Looks the target
 * user up by `metadata.vcpeer_live_user_id` (set at checkout time, see
 * lib/dodo.js) first, then falls back to an already-stored
 * `dodoCustomerId` for later events of the same subscription - metadata
 * isn't guaranteed on every event type, but the customer id is stable
 * once we've recorded it once. A no-op (never throws) for any event that
 * can't be resolved to an account - e.g. a stray webhook for a
 * subscription this app never issued the checkout for.
 *
 * Idempotent by construction: re-applying `subscription.active` for a
 * user already on Pro, or `subscription.cancelled` for a user already
 * on free, just writes the same plan again - safe against Dodo's
 * at-least-once retry delivery without needing a separate dedupe table.
 */
function applyWebhookEvent(store, event) {
  const data = event && event.data ? event.data : {};
  const metadata = data.metadata || {};
  const customerId = (data.customer && data.customer.customer_id) || null;
  const subscriptionId = data.subscription_id || null;
  const userIdFromMetadata = typeof metadata.vcpeer_live_user_id === 'string' ? metadata.vcpeer_live_user_id : null;

  store.update((current) => {
    let targetUserId = null;
    if (userIdFromMetadata && current.users.some((u) => u.id === userIdFromMetadata)) {
      targetUserId = userIdFromMetadata;
    } else if (customerId) {
      const byCustomer = current.users.find((u) => u.dodoCustomerId === customerId);
      if (byCustomer) targetUserId = byCustomer.id;
    }
    if (!targetUserId) return current;

    if (PRO_EVENTS.has(event.type)) {
      const existing = current.users.find((u) => u.id === targetUserId);
      return patchUserBilling(current, targetUserId, {
        plan: PRO_PLAN,
        dodoCustomerId: customerId || existing.dodoCustomerId || null,
        dodoSubscriptionId: subscriptionId || existing.dodoSubscriptionId || null,
        proSince: existing.proSince || new Date().toISOString(),
      });
    }

    if (FREE_EVENTS.has(event.type)) {
      return patchUserBilling(current, targetUserId, { plan: FREE_PLAN });
    }

    // Any other subscribed event type (e.g. payment.succeeded) never
    // changes plan - it only backfills the customer id the first time
    // we see it, so later events can resolve via dodoCustomerId alone.
    const user = current.users.find((u) => u.id === targetUserId);
    if (customerId && user && !user.dodoCustomerId) {
      return patchUserBilling(current, targetUserId, { dodoCustomerId: customerId });
    }
    return current;
  });
}

function buildBillingRouter(store) {
  const router = express.Router();

  router.get('/status', requireAuth(store), (req, res) => {
    const profile = getBillingProfile(store.get(), req.user.id);
    return res.json({
      configured: dodo.isConfigured(),
      plan: profile ? profile.plan : FREE_PLAN,
      proSince: profile ? profile.proSince : null,
      hasPortalAccess: Boolean(profile && profile.dodoCustomerId),
    });
  });

  // VCPeer Live is free for everyone (owner decision 2026-10-27: VCPeer is
  // off the paid server, no more billing). getPlan() in lib/billing.js now
  // always returns PRO_PLAN, so there is nothing left to upgrade to and no
  // subscription to manage - both routes are kept (not deleted) so old
  // clients/bookmarks get a clear, honest response instead of a 404.
  router.post('/checkout', requireAuth(store), (req, res) => {
    return res.status(409).json({ error: 'VCPeer Live is free - every feature is already included, no upgrade needed.' });
  });

  router.post('/portal', requireAuth(store), (req, res) => {
    return res.status(404).json({ error: 'VCPeer Live is free - there is no subscription to manage.' });
  });

  return router;
}

/**
 * Standalone Express handler (not part of buildBillingRouter's router)
 * because it needs the exact raw bytes Dodo sent for signature
 * verification. server.js mounts this directly at `POST
 * /api/billing/webhook` with `express.raw({ type: 'application/json' })`
 * BEFORE the app-wide `express.json()` runs - any body express.json()
 * had already parsed and this handler then re-serialized would not
 * match the signature at all.
 */
function buildBillingWebhookHandler(store) {
  return (req, res) => {
    const id = req.headers['webhook-id'];
    const timestamp = req.headers['webhook-timestamp'];
    const signature = req.headers['webhook-signature'];
    if (!id || !timestamp || !signature) {
      return res.status(400).json({ error: 'missing signature headers' });
    }

    const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body || '');
    const secret = process.env.DODO_PAYMENTS_WEBHOOK_KEY;
    if (!secret || !dodo.verifyWebhookSignature(rawBody, { id, timestamp, signature }, secret)) {
      return res.status(401).json({ error: 'invalid signature' });
    }

    let event;
    try {
      event = JSON.parse(rawBody);
    } catch {
      return res.status(400).json({ error: 'invalid payload' });
    }

    try {
      applyWebhookEvent(store, event);
      return res.json({ received: true });
    } catch (err) {
      // Non-2xx makes Dodo retry - nothing durable happened yet if this throws.
      console.error('vcpeer-live billing: webhook processing failed:', err.message);
      return res.status(500).json({ error: 'processing failed' });
    }
  };
}

module.exports = { buildBillingRouter, buildBillingWebhookHandler, applyWebhookEvent };
