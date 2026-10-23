'use strict';

const express = require('express');

const { requireAuth } = require('../lib/auth');
const { isValidEmail } = require('../lib/validate');
const team = require('../lib/team');
const { getPlan } = require('../lib/billing');
const { sendTeamInviteEmail } = require('../lib/mailer');

/**
 * Multi-seat team access to one owner's set of destinations - the
 * Pro-gated deliverable `PLAN-2026-10-23-DEEP.md` item 5 named. A team
 * member goes live using the OWNER's ingest key/destinations/broadcast
 * history (see lib/team.js effectiveOwnerId, wired into routes/live.js
 * and routes/destinations.js) - this router only manages the invite/
 * membership bookkeeping itself.
 */
function buildTeamRouter(store, { publicUrl, isDev, sendInviteEmail = sendTeamInviteEmail } = {}) {
  const router = express.Router();
  router.use(requireAuth(store));

  router.get('/', (req, res) => {
    const data = store.get();
    const membership = team.membershipOf(data, req.user.id);
    const owner = membership ? data.users.find((u) => u.id === membership.ownerId) : null;
    const members = team.membersOf(data, req.user.id).map((m) => {
      const user = data.users.find((u) => u.id === m.memberUserId);
      return { userId: m.memberUserId, email: user ? user.email : 'unknown', joinedAt: m.joinedAt };
    });
    const invites = team.pendingInvites(data, req.user.id).map((i) => ({ id: i.id, email: i.email, createdAt: i.createdAt }));
    return res.json({
      plan: getPlan(data, req.user.id),
      maxSeats: team.MAX_TEAM_SEATS,
      members,
      pendingInvites: invites,
      memberOfTeamOwnedBy: owner ? owner.email : null,
    });
  });

  router.post('/invites', async (req, res) => {
    const email = ((req.body && req.body.email) || '').trim().toLowerCase();
    if (!isValidEmail(email)) return res.status(400).json({ error: 'a valid email is required' });
    if (email === req.user.email) return res.status(400).json({ error: "that's your own email" });

    let invite = null;
    let createError = null;
    store.update((data) => {
      const result = team.createInvite(data, req.user.id, email);
      if (result.error) {
        createError = result.error;
        return data;
      }
      invite = result.invite;
      return result.data;
    });
    if (createError) return res.status(409).json({ error: createError });

    const link = `${publicUrl}/live?acceptInvite=${invite.token}`;
    const mailResult = await sendInviteEmail({ to: email, link, ownerEmail: req.user.email });
    if (isDev && !mailResult.sent) {
      return res.status(201).json({ ok: true, devLink: link });
    }
    if (!mailResult.sent) {
      console.error(`vcpeer-live team: invite email not delivered (${mailResult.reason})`);
      return res.status(201).json({
        ok: true,
        warning: 'Invite created, but the email failed to send - share this link with them directly.',
        devLink: link,
      });
    }
    return res.status(201).json({ ok: true });
  });

  router.delete('/invites/:id', (req, res) => {
    let removed = false;
    store.update((data) => {
      const result = team.revokeInvite(data, req.user.id, req.params.id);
      removed = result.removed;
      return result.data;
    });
    if (!removed) return res.status(404).json({ error: 'invite not found' });
    return res.status(204).end();
  });

  router.post('/invites/:token/accept', (req, res) => {
    let result = null;
    store.update((data) => {
      result = team.acceptInvite(data, req.params.token, req.user.id);
      return result.data || data;
    });
    if (result.error) return res.status(409).json({ error: result.error });
    return res.json({ ok: true, membership: result.membership });
  });

  router.delete('/members/:userId', (req, res) => {
    let removed = false;
    store.update((data) => {
      const result = team.removeMember(data, req.user.id, req.params.userId);
      removed = result.removed;
      return result.data;
    });
    if (!removed) return res.status(404).json({ error: 'member not found' });
    return res.status(204).end();
  });

  // Self-service departure for a MEMBER leaving someone else's team -
  // distinct from DELETE /members/:userId, which is the owner removing
  // someone. Always 200s, even if the user wasn't on any team.
  router.post('/leave', (req, res) => {
    store.update((data) => team.leaveTeam(data, req.user.id).data);
    return res.json({ ok: true });
  });

  return router;
}

module.exports = { buildTeamRouter };
