'use strict';

const nodemailer = require('nodemailer');

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
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const from = process.env.SMTP_FROM || 'VCPeer Live <live@vcpeer.com>';

  if (!host || !user || !pass) {
    return { sent: false, reason: 'smtp_not_configured' };
  }

  try {
    const transporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: { user, pass },
    });
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

module.exports = { sendMagicLinkEmail };
