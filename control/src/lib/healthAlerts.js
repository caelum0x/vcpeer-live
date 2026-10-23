'use strict';

const { readFanoutStatus } = require('./live');

/**
 * Debounced stream-health failure alerting. fanout.sh (via the
 * per-destination `.state` files item 1 added) already gives up on a
 * destination after its retry budget runs out and writes
 * `state: "failed"` - but nobody is told unless they happen to be
 * looking at the dashboard at that exact moment. This function is meant
 * to be polled on an interval independent of any open browser tab (see
 * server.js) so a dead platform mid-broadcast gets emailed to the
 * signed-in user even if they've tabbed away.
 *
 * Debouncing: `data.failureAlerts` (one entry per
 * `userId`+`ingestKey`+`destinationId`) records that an email has
 * already gone out for the CURRENT failure episode. A destination that
 * recovers (any state other than "failed") clears its entry, so a later,
 * genuinely new failure in a future broadcast alerts again - this is a
 * deliberate choice: silence a known-dead destination for the rest of
 * today's broadcast, not forever.
 *
 * Returns a NEW store object (same immutability contract as the rest of
 * this app) plus the list of alerts actually sent this pass, for
 * logging/testing.
 */
async function checkFailuresAndNotify(data, { sharedDir, sendEmail }) {
  const alerts = data.failureAlerts || [];
  let nextAlerts = alerts;
  const sent = [];

  for (const keyEntry of data.ingestKeys) {
    const { userId, key: ingestKey } = keyEntry;
    const status = readFanoutStatus({ sharedDir, ingestKey });
    if (!status.live) {
      // Not currently broadcasting - drop any stale alert rows for this
      // ingest key so the NEXT broadcast starts with a clean slate
      // (otherwise a destination that failed last Tuesday would stay
      // silently suppressed forever).
      nextAlerts = nextAlerts.filter((a) => a.ingestKey !== ingestKey);
      continue;
    }

    const failedIds = new Set(status.destinations.filter((d) => d.state === 'failed').map((d) => d.id));

    // Clear alert rows for destinations that are no longer failed
    // (recovered, or were re-armed/removed) so a future failure can
    // alert again.
    nextAlerts = nextAlerts.filter((a) => a.ingestKey !== ingestKey || failedIds.has(a.destinationId));

    for (const dest of status.destinations) {
      if (dest.state !== 'failed') continue;
      const alreadyAlerted = nextAlerts.some(
        (a) => a.ingestKey === ingestKey && a.destinationId === dest.id
      );
      if (alreadyAlerted) continue;

      const user = data.users.find((u) => u.id === userId);
      if (!user) continue;

      try {
        const result = await sendEmail({
          to: user.email,
          destinationLabel: dest.label,
          platform: dest.platform,
          lastError: dest.lastError,
        });
        if (result && result.sent) {
          sent.push({ userId, ingestKey, destinationId: dest.id, label: dest.label });
        }
      } catch (err) {
        console.error('vcpeer-live health-alerts: failed to send failure email:', err.message);
      }

      // Record the alert regardless of send success so a persistently
      // misconfigured mailer doesn't retry-storm on every poll tick -
      // the next readFanoutStatus poll will still see "failed" and this
      // debounce is what stops it from emailing (or trying to) every
      // interval.
      nextAlerts = [
        ...nextAlerts,
        { userId, ingestKey, destinationId: dest.id, notifiedAt: new Date().toISOString() },
      ];
    }
  }

  return { data: { ...data, failureAlerts: nextAlerts }, sent };
}

module.exports = { checkFailuresAndNotify };
