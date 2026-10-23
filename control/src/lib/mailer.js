'use strict';

const nodemailer = require('nodemailer');

/**
 * Builds the shared Scribase Mail SMTP transporter, or null if SMTP isn't
 * configured (local dev). Every send function below goes through this one
 * place so host/port/auth only needs to be read from env once.
 */
function buildTransporter() {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) return null;
  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });
}

/**
 * Sends the magic-link sign-in email via Scribase Mail SMTP. Host/port/
 * user/pass come from env (placeholders in .env.example - this app does
 * not talk to any real inbox during local/dev runs).
 *
 * Fails soft: if SMTP isn't configured (local dev) or the send fails, we
 * log that a link was issued (never the link or token itself in
 * non-dev mode) and let the caller's dev-mode fallback take over.
 */
async function sendMagicLinkEmail({ to, link }) {
  const from = process.env.SMTP_FROM || 'VCPeer Live <live@vcpeer.com>';
  const transporter = buildTransporter();
  if (!transporter) {
    return { sent: false, reason: 'smtp_not_configured' };
  }

  try {
    await transporter.sendMail({
      from,
      to,
      subject: 'Sign in to VCPeer Live',
      text: `Sign in to VCPeer Live: ${link}\n\nThis link expires in 15 minutes. If you did not request it, ignore this email.`,
      html: `<p>Sign in to <strong>VCPeer Live</strong>:</p><p><a href="${link}">${link}</a></p><p>This link expires in 15 minutes. If you did not request it, ignore this email.</p>`,
    });
    return { sent: true };
  } catch (err) {
    // Never include the link/token in the error log - only the failure.
    console.error('vcpeer-live mailer: failed to send magic link email:', err.message);
    return { sent: false, reason: 'send_failed' };
  }
}

/**
 * Sends a one-shot "your stream to X died" alert. Fails soft, same as
 * sendMagicLinkEmail - a mailer outage must never crash the health-check
 * loop that calls this (lib/healthAlerts.js), and that loop already
 * debounces so this is called at most once per failure episode.
 */
async function sendStreamFailureEmail({ to, destinationLabel, platform, lastError }) {
  const from = process.env.SMTP_FROM || 'VCPeer Live <live@vcpeer.com>';
  const transporter = buildTransporter();
  if (!transporter) {
    return { sent: false, reason: 'smtp_not_configured' };
  }

  const subject = `VCPeer Live: ${destinationLabel} stopped receiving your stream`;
  const reasonLine = lastError ? `Last error: ${lastError}` : '';
  try {
    await transporter.sendMail({
      from,
      to,
      subject,
      text:
        `Your broadcast is still live, but "${destinationLabel}" (${platform}) stopped receiving it after exhausting its retry budget. ${reasonLine}\n\n` +
        `Check the destination's RTMP URL and stream key, then toggle it off and back on from your dashboard to re-arm it: https://live.vcpeer.com/live`,
      html:
        `<p>Your broadcast is still live, but <strong>${destinationLabel}</strong> (${platform}) stopped receiving it after exhausting its retry budget.</p>` +
        (lastError ? `<p>Last error: <code>${lastError}</code></p>` : '') +
        `<p>Check the destination's RTMP URL and stream key, then toggle it off and back on from <a href="https://live.vcpeer.com/live">your dashboard</a> to re-arm it.</p>`,
    });
    return { sent: true };
  } catch (err) {
    console.error('vcpeer-live mailer: failed to send stream failure alert:', err.message);
    return { sent: false, reason: 'send_failed' };
  }
}

module.exports = { sendMagicLinkEmail, sendStreamFailureEmail };
