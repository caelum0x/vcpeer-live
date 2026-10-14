'use strict';

const PLATFORMS = new Set(['twitch', 'kick', 'youtube', 'custom']);

// Known default ingest hosts, used only to give a friendlier error message
// when someone pastes the wrong host for the platform they picked. Custom
// RTMP(S) destinations skip this check entirely.
const PLATFORM_HOST_HINTS = {
  twitch: /\.twitch\.tv$/i,
  kick: /\.kick\.com$/i,
  youtube: /\.youtube\.com$/i,
};

function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/**
 * Validates a destination payload. Returns { valid, errors } rather than
 * throwing - callers (routes, tests) decide how to surface errors.
 */
function validateDestination(input) {
  const errors = [];
  const body = input || {};

  if (!PLATFORMS.has(body.platform)) {
    errors.push(`platform must be one of: ${[...PLATFORMS].join(', ')}`);
  }

  if (typeof body.label !== 'string' || body.label.trim().length === 0) {
    errors.push('label is required');
  } else if (body.label.length > 80) {
    errors.push('label must be 80 characters or fewer');
  }

  let parsedUrl = null;
  if (typeof body.rtmpUrl !== 'string' || body.rtmpUrl.trim().length === 0) {
    errors.push('rtmpUrl is required');
  } else {
    try {
      parsedUrl = new URL(body.rtmpUrl.trim());
    } catch {
      errors.push('rtmpUrl must be a valid URL');
    }
    if (parsedUrl && !['rtmp:', 'rtmps:'].includes(parsedUrl.protocol)) {
      errors.push('rtmpUrl must use rtmp:// or rtmps://');
    }
    if (
      parsedUrl &&
      body.platform &&
      PLATFORM_HOST_HINTS[body.platform] &&
      !PLATFORM_HOST_HINTS[body.platform].test(parsedUrl.hostname)
    ) {
      errors.push(
        `rtmpUrl host "${parsedUrl.hostname}" does not look like a ${body.platform} ingest server - double check it, or use "custom" for non-standard endpoints`
      );
    }
  }

  if (typeof body.streamKey !== 'string' || body.streamKey.trim().length === 0) {
    errors.push('streamKey is required');
  } else if (body.streamKey.length > 512) {
    errors.push('streamKey is too long');
  }

  return { valid: errors.length === 0, errors };
}

module.exports = { validateDestination, isValidEmail, PLATFORMS };
