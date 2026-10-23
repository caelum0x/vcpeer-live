'use strict';

const { createHmac, timingSafeEqual } = require('crypto');

/**
 * Minimal Dodo Payments REST client - checkout sessions, customer portal
 * links, and Standard Webhooks signature verification. Deliberately a
 * plain `fetch()` wrapper (Node 20+ has it built in) instead of the
 * `dodopayments` SDK package: this app has exactly three server-side
 * calls to Dodo's API, not enough surface to justify a new dependency.
 * Ported from `~/products/bidstage-tenders/billing/dodo.ts`, which this
 * product's business/brand (see dodo-business-brands-structure memory)
 * is shared with.
 */

function isTestMode() {
  return process.env.DODO_PAYMENTS_TEST_MODE === 'true';
}

function baseUrl() {
  return isTestMode() ? 'https://test.dodopayments.com' : 'https://live.dodopayments.com';
}

/** True once every env var billing needs is set - gates the "Upgrade to Pro" UI/routes entirely when false. */
function isConfigured() {
  return Boolean(
    process.env.DODO_PAYMENTS_API_KEY && process.env.DODO_PAYMENTS_WEBHOOK_KEY && process.env.DODO_PRODUCT_PRO_MONTHLY
  );
}

/** Only ever hand a real dodopayments.com HTTPS URL to the browser - never an unvalidated redirect target. */
function trustedDodoUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    const hostOk = url.hostname === 'dodopayments.com' || url.hostname.endsWith('.dodopayments.com');
    if (url.protocol !== 'https:' || url.username || url.password || !hostOk) return null;
    return url.href;
  } catch {
    return null;
  }
}

function assertDodoId(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{4,160}$/.test(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

async function dodoRequest(path, { method, body, idempotencyKey } = { method: 'GET' }) {
  const apiKey = process.env.DODO_PAYMENTS_API_KEY;
  if (!apiKey) throw new Error('DODO_PAYMENTS_API_KEY is not set');
  const headers = { Accept: 'application/json', Authorization: `Bearer ${apiKey}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const response = await fetch(`${baseUrl()}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const parsed = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Dodo ${method} ${path.split('?')[0]} failed with status ${response.status}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Dodo returned a non-object body');
  }
  return parsed;
}

/**
 * Creates a hosted checkout session for the VCPeer Live Pro subscription.
 * `metadata.vcpeer_live_user_id` is carried onto the resulting
 * subscription and echoed back on every webhook event for it - that
 * metadata, not the browser's return-URL redirect, is what the webhook
 * handler trusts to find the right account to upgrade.
 */
async function createProCheckoutSession({ userId, email, returnUrl }) {
  const productId = process.env.DODO_PRODUCT_PRO_MONTHLY;
  if (!productId) throw new Error('DODO_PRODUCT_PRO_MONTHLY is not set');
  const body = await dodoRequest('/checkouts', {
    method: 'POST',
    idempotencyKey: `checkout:${userId}:${productId}:${Math.floor(Date.now() / (10 * 60 * 1000))}`,
    body: {
      product_cart: [{ product_id: productId, quantity: 1 }],
      customer: { email },
      return_url: returnUrl,
      metadata: { vcpeer_live_user_id: userId },
      feature_flags: { allow_discount_code: true },
    },
  });
  const checkoutUrl = trustedDodoUrl(body.checkout_url);
  if (typeof body.session_id !== 'string' || !checkoutUrl) {
    throw new Error('Dodo returned an invalid checkout session');
  }
  return { sessionId: body.session_id, checkoutUrl };
}

/** Builds a hosted customer-portal session link so a Pro user can manage/cancel their own subscription. */
async function createPortalLink(customerId, returnUrl) {
  const id = assertDodoId(customerId, 'Dodo customer id');
  const query = new URLSearchParams({ return_url: returnUrl });
  const body = await dodoRequest(`/customers/${encodeURIComponent(id)}/customer-portal/session?${query}`, {
    method: 'POST',
  });
  const link = trustedDodoUrl(body.link);
  if (!link) throw new Error('Dodo returned an untrusted portal link');
  return link;
}

/**
 * Standard Webhooks HMAC-SHA256 verification with a five-minute replay
 * window. The signed message is `webhook-id.webhook-timestamp.raw_body`
 * - verification requires the exact raw bytes Dodo sent, which is why
 * `routes/billing.js` mounts this route with `express.raw()` ahead of
 * the app-wide `express.json()` middleware.
 */
function verifyWebhookSignature(rawBody, headers, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!headers || typeof headers.id !== 'string' || typeof headers.timestamp !== 'string' || typeof headers.signature !== 'string') {
    return false;
  }
  if (!/^[A-Za-z0-9_-]{6,200}$/.test(headers.id) || !/^\d{10}$/.test(headers.timestamp)) return false;
  const timestamp = Number(headers.timestamp);
  if (!Number.isSafeInteger(timestamp) || Math.abs(nowSeconds - timestamp) > 300) return false;

  const encodedSecret = secret.startsWith('whsec_') ? secret.slice(6) : secret;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encodedSecret)) return false;
  const key = Buffer.from(encodedSecret, 'base64');
  if (key.length < 24 || key.length > 64) return false;
  const expected = createHmac('sha256', key).update(`${headers.id}.${headers.timestamp}.${rawBody}`).digest();

  for (const versioned of headers.signature.trim().split(/\s+/).slice(0, 16)) {
    const separator = versioned.indexOf(',');
    if (separator < 0 || versioned.slice(0, separator) !== 'v1') continue;
    const encoded = versioned.slice(separator + 1);
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) continue;
    const supplied = Buffer.from(encoded, 'base64');
    if (supplied.length === expected.length && timingSafeEqual(supplied, expected)) return true;
  }
  return false;
}

module.exports = {
  isConfigured,
  isTestMode,
  trustedDodoUrl,
  assertDodoId,
  createProCheckoutSession,
  createPortalLink,
  verifyWebhookSignature,
};
