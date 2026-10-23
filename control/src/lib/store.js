'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Tiny JSON-file backed store. VCPeer Live has no multi-tenant scale
 * requirement yet (one small control app, a handful of destinations per
 * user) so a real database is unneeded weight. Every mutation reads,
 * returns a NEW object with the change applied, then writes the whole
 * file - no in-place mutation of the loaded document.
 */
class JsonStore {
  constructor(filePath) {
    this.filePath = filePath;
    this._ensureFile();
  }

  _ensureFile() {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(this.filePath)) {
      this._write({
        users: [],
        magicLinks: [],
        sessions: [],
        destinations: [],
        ingestKeys: [],
        broadcasts: [],
        failureAlerts: [],
        teamMembers: [],
        teamInvites: [],
      });
    }
  }

  _read() {
    const raw = fs.readFileSync(this.filePath, 'utf8');
    const data = JSON.parse(raw);
    // Defaults any collection added after a given db.json was first
    // written, so an existing production file (no teamMembers/
    // teamInvites arrays yet) doesn't need a manual migration - every
    // lib already also defensively reads `data.x || []` on top of this,
    // this is just belt-and-suspenders for anything that doesn't.
    return {
      users: [],
      magicLinks: [],
      sessions: [],
      destinations: [],
      ingestKeys: [],
      broadcasts: [],
      failureAlerts: [],
      teamMembers: [],
      teamInvites: [],
      ...data,
    };
  }

  _write(data) {
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, this.filePath);
  }

  /** Runs `fn(data)` and persists whatever new object it returns. */
  update(fn) {
    const current = this._read();
    const next = fn(current);
    this._write(next);
    return next;
  }

  get() {
    return this._read();
  }
}

module.exports = { JsonStore };
